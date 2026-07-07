import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart'; // defaultTargetPlatform / TargetPlatform
import 'package:flutter/material.dart';
import 'package:flutter/services.dart'; // SystemSound + HapticFeedback (earcons)
import 'package:flutter_tts/flutter_tts.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../api.dart';
import '../models.dart';
import '../settings.dart';
import '../theme.dart';
import '../voice_errors.dart';

/// One conversation: streaming text + native voice (talking mode).
class ChatScreen extends StatefulWidget {
  final AppSettings settings;
  final Session session;
  const ChatScreen({super.key, required this.settings, required this.session});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late final Api _api = Api(widget.settings);
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _messages = <Message>[];

  final SpeechToText _stt = SpeechToText();
  final FlutterTts _tts = FlutterTts();
  bool _sttReady = false;

  bool _busy = false;
  bool _talking = false; // continuous voice loop
  bool _listening = false;
  bool _talkMuted = false; // mic paused inside talking mode (without exiting)
  bool _canSend = false;
  bool _hideActivity = false; // hide ⚙︎ tool/bash activity lines from the chat
  SessionWatch? _watch; // self-reconnecting live transcript watch (#141)
  final List<String> _sentEcho = []; // optimistic sends awaiting their watch echo
  bool get _isTmux => widget.session.runner == 'tmux';
  bool _ttsSpeaking = false; // true while TTS is actually producing audio
  Message? _ttsMsg; // message being read aloud via its bubble button (null = none)
  DateTime? _lastVoiceErrorAt;
  String? _lastVoiceErrorText;

  // Autonomy mode — starts from the session's, but changeable from settings.
  // Sent with every turn (the bridge also updates the stored session mode).
  late String _mode = widget.session.mode;
  List<Map<String, dynamic>> _modes = const []; // [{id, label}] for this agent
  // Display name — editable from settings (the Session model's is immutable).
  late String _name = widget.session.name;

  static const _locale = 'en-US';

  String get _histKey => 'vb_hist_${widget.session.id}';

  @override
  void initState() {
    super.initState();
    _tts.setLanguage(_locale);
    _tts.awaitSpeakCompletion(true);
    // Upgrade off the default *compact* system voice (the robotic sound) to the
    // best installed neural voice for the locale. Runs async; see _configureBestVoice.
    _configureBestVoice();
    // Track real TTS audio state so the orb shows "Speaking" only while audio is
    // actually playing (not inferred), and so the "Read aloud" button flips back.
    // These are independent of awaitSpeakCompletion (which resolves speak() via the
    // native result), so they don't affect the talking-loop await.
    _tts.setStartHandler(() { if (mounted) setState(() => _ttsSpeaking = true); });
    _tts.setCompletionHandler(() {
      if (mounted) setState(() { _ttsMsg = null; _ttsSpeaking = false; });
    });
    _tts.setCancelHandler(() {
      if (mounted) setState(() { _ttsMsg = null; _ttsSpeaking = false; });
    });
    _tts.setErrorHandler((msg) {
      _markNotSpeaking();
      _voiceFailure(ttsFailureMessage(msg));
    });
    // iOS audio session — configured ONCE here (not before every utterance).
    // Re-applying the category per reply churns the live AVAudioSession route
    // mid-stream, which is what made speech choppy.
    //
    // Routing for hands-free use (car / AirPods): .playback implicitly reaches
    // Bluetooth A2DP / CarPlay / AirPlay; allowBluetoothA2DP + allowAirPlay make
    // that explicit. We must NOT set defaultToSpeaker — it force-routes to the
    // built-in speaker and is exactly why CarPlay/AirPods were silent. voicePrompt
    // mode routes correctly to CarPlay/external devices. mixWithOthers is kept on
    // purpose: it stops flutter_tts from deactivating the shared session between
    // turns (the original "silent after the first reply" fix).
    // iOS-only: AVAudioSession category. On macOS these throw MissingPluginException
    // (no flutter_tts macOS impl) and would break talking mode — so guard them.
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      _tts.setSharedInstance(true);
      _tts.setIosAudioCategory(
        IosTextToSpeechAudioCategory.playback,
        [
          IosTextToSpeechAudioCategoryOptions.mixWithOthers,
          IosTextToSpeechAudioCategoryOptions.duckOthers, // duck Spotify while speaking → conversational on CarPlay, not bleeding through (#133)
          IosTextToSpeechAudioCategoryOptions.allowBluetoothA2DP, // stereo BT / CarPlay
          IosTextToSpeechAudioCategoryOptions.allowAirPlay,
        ],
        IosTextToSpeechAudioMode.voicePrompt,
      );
    }
    _input.addListener(() {
      final can = _input.text.trim().isNotEmpty;
      if (can != _canSend) setState(() => _canSend = can);
    });
    if (_isTmux) {
      _startTmuxSync(); // full sessions: server transcript is the source of truth
    } else {
      _loadHistory();
    }
    _loadModes();
    SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _hideActivity = p.getBool('vb_hide_activity') ?? false);
    });
  }

  Future<void> _toggleHideActivity() async {
    setState(() => _hideActivity = !_hideActivity);
    final p = await SharedPreferences.getInstance();
    await p.setBool('vb_hide_activity', _hideActivity);
  }

  // Full (tmux) sessions: load the server transcript, then watch for every new
  // turn from ANY source (this app, the local CLI, Remote Control, another
  // client). The server transcript is the single source of truth — no optimistic
  // echo, so nothing duplicates and nothing goes missing (#141).
  Future<void> _startTmuxSync() async {
    int offset = 0;
    try {
      final h = await _api.sessionHistory(widget.session.id);
      offset = (h['size'] as num?)?.toInt() ?? 0;
      final turns = (h['turns'] as List?) ?? const [];
      if (mounted) {
        setState(() {
          _messages
            ..clear()
            ..addAll(turns.map((t) {
              final m = t as Map<String, dynamic>;
              return Message(m['role'] == 'assistant' ? 'claude' : 'me',
                  (m['text'] ?? '') as String);
            }));
        });
        _toBottom();
      }
    } catch (_) {/* fresh session / no transcript yet */}
    _watch = _api.watchSession(widget.session.id, offset, onTurn: _onWatchTurn);
  }

  void _onWatchTurn(String role, String text) {
    if (!mounted || text.trim().isEmpty) return;
    if (role != 'assistant') {
      // Our own message already shown optimistically — skip the watch echo.
      final i = _sentEcho.indexWhere((s) => s.trim() == text.trim());
      if (i >= 0) {
        _sentEcho.removeAt(i);
        return;
      }
    }
    setState(() =>
        _messages.add(Message(role == 'assistant' ? 'claude' : 'me', text)));
    _toBottom();
    if (role == 'assistant' && _talking) _speak(text, summarize: true);
  }

  // Full (tmux) sessions: fire-and-forget the input; the watch renders the turn
  // and the reply. No _busy block — so a prompt/question waiting in the session
  // never freezes the app, and you can answer it ("y"/"1"/…) right away.
  Future<void> _sendTmux(String text) async {
    _tts.stop();
    _input.clear();
    setState(() => _messages.add(Message('me', text))); // show it instantly
    _sentEcho.add(text);
    _toBottom();
    try {
      await _api.tmuxSend(widget.session.id, text);
    } catch (e) {
      if (mounted) {
        setState(() => _messages.add(
            Message('sys', '⚠️ ${e.toString().replaceFirst('Exception: ', '')}')));
      }
    }
  }

  // Pick the highest-quality installed voice for the locale. flutter_tts otherwise
  // falls back to the default *compact* system voice — that's the robotic sound.
  // Enhanced/premium neural voices ship with iOS/Android and run fully offline
  // (the user downloads them once in Settings → Accessibility → Spoken Content →
  // Voices), so this keeps the hands-free car/CarPlay path network-free.
  // Persisted TTS voice name chosen in the picker (#125).
  static const _voiceKey = 'vb_tts_voice';

  // Installed en voices, best-quality first (premium > enhanced > compact).
  Future<List<Map<String, String>>> _turkishVoices() async {
    try {
      final raw = await _tts.getVoices;
      if (raw is! List) return const [];
      final voices = raw
          .whereType<Map>()
          .map((e) => e.map((k, v) => MapEntry('$k', '$v')))
          .where((v) => (v['locale'] ?? '').toLowerCase().startsWith('en'))
          .toList();
      int rank(Map<String, String> v) {
        final q = (v['quality'] ?? '').toLowerCase();
        if (q.contains('premium')) return 3;
        if (q.contains('enhanced')) return 2;
        return 1;
      }
      voices.sort((a, b) => rank(b).compareTo(rank(a)));
      return voices;
    } catch (_) {
      return const [];
    }
  }

  String _voiceQualityLabel(String? q) {
    final s = (q ?? '').toLowerCase();
    if (s.contains('premium')) return 'Premium (neural)';
    if (s.contains('enhanced')) return 'Enhanced';
    return 'Standard';
  }

  Future<void> _configureBestVoice() async {
    // Slightly slower than the racy plugin default; steadier for long replies.
    await _tts.setSpeechRate(0.5);
    await _tts.setPitch(1.0);
    final voices = await _turkishVoices();
    if (voices.isEmpty) return; // no English voice installed → keep default
    // Prefer the user's saved pick if it's still installed (#125); else best.
    final p = await SharedPreferences.getInstance();
    final savedName = p.getString(_voiceKey);
    final chosen = (savedName != null)
        ? voices.firstWhere((v) => v['name'] == savedName, orElse: () => voices.first)
        : voices.first;
    try {
      await _tts.setVoice({'name': chosen['name']!, 'locale': chosen['locale']!});
      debugPrint('TTS voice → ${chosen['name']} (${chosen['quality']})');
    } catch (e) {
      debugPrint('TTS setVoice failed: $e');
    }
  }

  // In-app voice picker (#125): list the installed en voices, persist the
  // choice, apply it, and speak a sample so it's heard immediately. iOS 26
  // ignores the system-selected voice, so picking explicitly here is the fix.
  Future<void> _pickVoice() async {
    final voices = await _turkishVoices();
    if (!mounted) return;
    if (voices.isEmpty) {
      _toast('No English voice installed. Download one from Settings → Accessibility → Spoken Content → Voices.');
      return;
    }
    final p = await SharedPreferences.getInstance();
    final savedName = p.getString(_voiceKey);
    if (!mounted) return;
    final picked = await showModalBottomSheet<Map<String, String>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => Container(
        decoration: BoxDecoration(
          color: VbColors.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
        child: SafeArea(
          top: false,
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
            children: [
              const Center(child: _Grabber()),
              const SizedBox(height: 10),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                child: Text('Choose a voice',
                    style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: VbColors.textPrimary)),
              ),
              for (final v in voices)
                ListTile(
                  title: Text(v['name'] ?? '',
                      style: TextStyle(color: VbColors.textPrimary)),
                  subtitle: Text(_voiceQualityLabel(v['quality']),
                      style: TextStyle(color: VbColors.textMuted)),
                  trailing: v['name'] == savedName
                      ? Icon(Icons.check_rounded, color: VbColors.accent)
                      : null,
                  onTap: () => Navigator.pop(context, v),
                ),
            ],
          ),
        ),
      ),
    );
    if (picked == null) return;
    await p.setString(_voiceKey, picked['name']!);
    var spoke = false;
    try {
      await _tts.setVoice({'name': picked['name']!, 'locale': picked['locale']!});
      spoke = await _speak('Hello, I\'ll speak with this voice from now on.'); // hear it right away
    } catch (e) {
      _voiceFailure(ttsFailureMessage(e));
    }
    if (mounted && spoke) _toast('Voice selected: ${picked['name']}');
  }

  // The autonomy modes this agent supports (label + id), for the settings sheet.
  Future<void> _loadModes() async {
    try {
      final cfg = await _api.config();
      final agents = (cfg['agents'] as List?) ?? const [];
      final a = agents.firstWhere(
        (e) => e is Map && e['id'] == widget.session.agent,
        orElse: () => null,
      );
      if (a == null) return;
      final modes = ((a['modes'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList();
      if (mounted) setState(() => _modes = modes);
    } catch (_) {/* offline / cloud session — settings just won't list modes */}
  }

  String _modeLabel(String id) {
    final m = _modes.firstWhere((e) => e['id'] == id, orElse: () => const {});
    return (m['label'] as String?) ?? id;
  }

  // Header subtitle, recomputed from the live mode (not the stale session one).
  String get _subtitle {
    final parts = <String>[];
    if (widget.session.agentLabel.isNotEmpty) parts.add(widget.session.agentLabel);
    if (_mode.isNotEmpty) parts.add(_modeLabel(_mode));
    parts.add(widget.session.runner == 'cloud' ? '☁︎ cloud' : 'local');
    return parts.join(' · ');
  }

  // ---- History (persisted per session, like the web client) ----
  Future<void> _loadHistory() async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_histKey);
      if (raw == null) return;
      final list = (jsonDecode(raw) as List)
          .map((e) => Message.fromJson(e as Map<String, dynamic>))
          .toList();
      if (mounted && list.isNotEmpty) {
        setState(() => _messages
          ..clear()
          ..addAll(list));
        _toBottom();
      }
    } catch (_) {}
  }

  Future<void> _persist() async {
    try {
      final p = await SharedPreferences.getInstance();
      final tail = _messages.length > 200
          ? _messages.sublist(_messages.length - 200)
          : _messages;
      await p.setString(_histKey, jsonEncode(tail.map((m) => m.toJson()).toList()));
    } catch (_) {}
  }

  @override
  void dispose() {
    _watch?.close(); // stop the live transcript watch (#141)
    WakelockPlus.disable();
    _stt.cancel();
    _tts.stop();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _markNotListening() {
    if (mounted) setState(() => _listening = false);
  }

  void _markNotSpeaking() {
    if (mounted) {
      setState(() {
        _ttsMsg = null;
        _ttsSpeaking = false;
      });
    }
  }

  void _voiceFailure(String message) {
    if (!mounted) {
      debugPrint('voicebridge voice error after dispose: $message');
      return;
    }
    final now = DateTime.now();
    if (_lastVoiceErrorText == message &&
        _lastVoiceErrorAt != null &&
        now.difference(_lastVoiceErrorAt!) < const Duration(seconds: 2)) {
      return;
    }
    _lastVoiceErrorAt = now;
    _lastVoiceErrorText = message;
    debugPrint('voicebridge voice error: $message');
    _cue('error');
    _toast(message);
  }

  Future<bool> _ensureStt() async {
    if (_sttReady) return true;
    try {
      _sttReady = await _stt.initialize(
        // Small fallback: promote the last partial to a final if iOS ends listening
        // without emitting its own — enough that the hands-free loop never stalls,
        // but well below the old 2000ms window that caused premature first-turn submits.
        finalTimeout: const Duration(milliseconds: 800),
        onStatus: (s) {
          if (s == 'done' || s == 'notListening') {
            _markNotListening();
          }
        },
        onError: (e) {
          _markNotListening();
          _voiceFailure(sttFailureMessage(e.errorMsg));
        },
      );
    } catch (e) {
      _sttReady = false;
      _markNotListening();
      _voiceFailure(sttFailureMessage(e));
      return false;
    }
    if (!_sttReady) {
      _markNotListening();
      _voiceFailure(sttUnavailableMessage);
    }
    return _sttReady;
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  // Earcon: a short eyes-free cue (audible over AirPods/CarPlay + a haptic) for
  // state changes, so you don't have to look at the orb while driving. Uses only
  // built-in system sounds/haptics — no extra audio dependency.
  void _cue(String kind) {
    switch (kind) {
      case 'listen': // mic opened — your turn
        SystemSound.play(SystemSoundType.click);
        HapticFeedback.selectionClick();
        break;
      case 'sent': // captured what you said
        SystemSound.play(SystemSoundType.click);
        HapticFeedback.lightImpact();
        break;
      case 'error':
        SystemSound.play(SystemSoundType.alert);
        HapticFeedback.heavyImpact();
        break;
    }
  }

  // ---- Voice ----
  Future<void> _listen() async {
    if (_talkMuted) return;
    if (!await _ensureStt()) {
      _markNotListening();
      return;
    }
    if (_stt.isListening) return; // guard against a double-start after the TTS handoff

    setState(() => _listening = true);
    if (_talking) _cue('listen'); // audible "your turn" cue in talking mode

    // Start with a generous pause so the COLD first-turn recognizer warm-up can't
    // trip the pause watchdog before the user has even started speaking (the cause
    // of the first sentence being cut off). Once a real partial lands, tighten it so
    // the turn still auto-submits promptly when the user genuinely stops.
    const longPause = Duration(seconds: 6);
    const shortPause = Duration(milliseconds: 2000);
    var tightened = false;

    try {
      await _stt.listen(
        localeId: _locale,
        listenFor: const Duration(seconds: 30),
        pauseFor: longPause,
        listenOptions: SpeechListenOptions(
          listenMode: ListenMode.dictation, // long-form; far less eager to finalize than the default
          partialResults: true,
          onDevice: false, // en uses server recognition
          autoPunctuation: true,
          cancelOnError: false,
        ),
        onResult: (r) {
          if (!tightened && r.recognizedWords.trim().isNotEmpty) {
            tightened = true;
            try {
              if (_stt.isListening) _stt.changePauseFor(shortPause);
            } catch (e) {
              debugPrint('voicebridge STT pause update ignored: $e');
            }
          }
          if (r.finalResult) {
            final t = r.recognizedWords.trim();
            setState(() => _listening = false);
            if (t.isNotEmpty) {
              if (_talking) _cue('sent');
              _send(t);
            }
          }
        },
      );
    } catch (e) {
      _markNotListening();
      _voiceFailure(sttFailureMessage(e));
    }
  }

  // Longest auto-read (talking loop) before we shorten to the lead (#124).
  static const int _speakMaxChars = 600;

  // Clean text for TTS: drop code/markdown so it isn't read as symbols. When
  // [summarize] (hands-free talking loop), a long reply is shortened to its lead
  // sentences plus an "on screen" cue — the explicit "Read aloud" button passes
  // summarize:false to read the whole thing. Pure client-side, works offline.
  String _forSpeech(String text, {bool summarize = false}) {
    var s = text
        .replaceAll(RegExp(r'```[\s\S]*?```'), ' (code) ') // fenced code → marker
        .replaceAll('`', ''); // inline code ticks
    s = s.replaceAll(RegExp(r'^#{1,6}\s*', multiLine: true), ''); // headings
    s = s.replaceAll(RegExp(r'^\s*[-*]\s+', multiLine: true), ''); // list bullets
    s = s.replaceAllMapped(RegExp(r'\*\*([^*]+)\*\*'), (m) => m[1]!); // bold → text
    s = s.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1]!); // links → text
    s = s.replaceAll(RegExp(r'\(code\)(?:\s*\(code\))+'), '(code)'); // collapse repeats
    s = s.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (!summarize || s.length <= _speakMaxChars) return s;
    final head = s.substring(0, _speakMaxChars);
    // End on a whole sentence; (?<!\d) skips a period that just follows a number
    // (e.g. "36.") so we don't cut mid-sentence.
    final stop = head.lastIndexOf(RegExp(r'(?<!\d)[.!?…]'));
    final lead = (stop > 200 ? head.substring(0, stop + 1) : head).trim();
    return '$lead … (long reply, full text on screen)';
  }

  Future<bool> _speak(String text, {bool summarize = false}) async {
    final clean = _forSpeech(text, summarize: summarize);
    if (clean.isEmpty) return true;
    // The audio session is configured ONCE in initState and kept alive by
    // mixWithOthers, so we do NOT stop()/re-assert the category/sleep before every
    // utterance — that churn is what made speech choppy. Just release the mic so it
    // isn't holding the input route. (The mic→TTS session re-assert that keeps
    // replies audible happens once on the handoff in _send.)
    try {
      await _stt.stop();
    } catch (e) {
      debugPrint('voicebridge STT stop before TTS failed: $e');
    }
    try {
      final result = await _tts.speak(clean); // awaitSpeakCompletion(true) → resolves on didFinish
      if (result == 0 || result == false) {
        _markNotSpeaking();
        _voiceFailure(ttsFailureMessage('TTS engine rejected speak request'));
        return false;
      }
      return true;
    } catch (e) {
      _markNotSpeaking();
      _voiceFailure(ttsFailureMessage(e));
      return false;
    }
  }

  // Per-message "Read aloud" toggle (the bubble button). _ttsMsg tracks which
  // message is playing so the button shows "Stop" and a second tap stops it.
  Future<void> _readAloud(Message m) async {
    await _tts.stop(); // halt any current readout first (also lets you switch messages)
    if (!mounted) return;
    setState(() => _ttsMsg = m);
    await _speak(m.text);
    // Safety net: if the text was empty, no completion handler fires — clear here.
    if (mounted && _ttsMsg == m) setState(() => _ttsMsg = null);
  }

  Future<void> _stopSpeak() async {
    await _tts.stop();
    if (mounted) setState(() => _ttsMsg = null);
  }

  void _toggleTalking() async {
    if (_talking) {
      setState(() { _talking = false; _talkMuted = false; });
      WakelockPlus.disable();
      await _stt.stop();
      await _tts.stop();
      setState(() => _listening = false);
      return;
    }
    if (!await _ensureStt()) return;
    setState(() { _talking = true; _talkMuted = false; });
    WakelockPlus.enable(); // keep the screen on so the bridge connection doesn't drop
    _listen();
  }

  // Tap the orb: barge-in while it's speaking (cut the readout short and listen),
  // otherwise pause/resume the mic — all without leaving talking mode.
  void _toggleMute() async {
    if (!_talking) return;
    // Barge-in: a tap during playback stops TTS and hands the turn back to you.
    if (_ttsSpeaking) {
      await _tts.stop();
      setState(() { _ttsSpeaking = false; _talkMuted = false; });
      _listen();
      return;
    }
    if (_talkMuted) {
      setState(() => _talkMuted = false);
      if (!_busy) _listen(); // resume listening
    } else {
      setState(() {
        _talkMuted = true;
        _listening = false;
      });
      await _stt.stop(); // pause the mic (TTS keeps playing)
    }
  }

  // ---- Send + stream ----
  Future<void> _send(String text) async {
    if (_isTmux) return _sendTmux(text); // full sessions render via the watch
    if (_busy) return;
    _tts.stop(); // barge-in: a new message interrupts any ongoing spoken readout
    _input.clear();
    final me = Message('me', text);
    final reply = Message('claude', '');
    setState(() {
      _messages.add(me);
      _messages.add(reply);
      _busy = true;
    });
    _toBottom();
    try {
      final full = await _api.ask(
        sessionId: widget.session.id,
        text: text,
        mode: _mode,
        onDelta: (d) {
          setState(() => reply.text += d);
          _toBottom();
        },
        onActivity: (a) {
          setState(() => _messages.add(Message('activity', '⚙︎ $a')));
          _toBottom();
        },
      );
      if (full.trim().isEmpty) setState(() => reply.text = '(empty reply)');
      // Turn (network/agent) is done — release _busy NOW so the user can type and
      // send a new message during the spoken readout below (it barge-ins the TTS).
      if (mounted) setState(() => _busy = false);
      if (_talking && full.trim().isNotEmpty) {
        await _stt.stop(); // release the mic's audio session before TTS speaks
        // The mic just left the shared session in record/.playAndRecord state.
        // Re-claim the route-friendly playback category ONCE here (not per
        // utterance) so the reply reaches CarPlay/AirPods instead of being silenced
        // or mis-routed.
        if (defaultTargetPlatform == TargetPlatform.iOS) {
          await _tts.setIosAudioCategory(
            IosTextToSpeechAudioCategory.playback,
            [
              IosTextToSpeechAudioCategoryOptions.mixWithOthers,
              IosTextToSpeechAudioCategoryOptions.duckOthers, // duck music while speaking (#133)
              IosTextToSpeechAudioCategoryOptions.allowBluetoothA2DP,
              IosTextToSpeechAudioCategoryOptions.allowAirPlay,
            ],
            IosTextToSpeechAudioMode.voicePrompt,
          );
        }
        await _speak(full, summarize: true); // hands-free: read the lead, not 200 lines
        if (_talking && !_talkMuted && !_busy) _listen(); // skip if a new turn already started
      }
    } catch (e) {
      if (_talking) _cue('error');
      setState(() => _messages
          .add(Message('sys', '⚠️ ${e.toString().replaceFirst('Exception: ', '')}')));
      // Eyes-free recovery: a transient error shouldn't silently drop talking mode —
      // keep listening so the user can retry by voice (e.g. while driving).
      if (_talking && !_talkMuted) {
        _listen();
      } else if (_talking) {
        _toggleTalking();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _persist();
    }
  }

  // ---- Command palette: the project's slash commands + npm scripts ----
  Future<void> _openPalette() async {
    final groups = await _api.commands(widget.session.id);
    if (!mounted) return;
    if (groups.isEmpty) {
      _toast('No commands found for this session (it may be a cloud session).');
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _CommandSheet(groups: groups),
    );
    if (picked != null) {
      final cmd = picked.trim();
      if (cmd.isNotEmpty) _send(cmd); // run the command immediately on pick
    }
  }

  // ---- Session settings: rename + mode (autonomy) selector ----
  Future<void> _openSessionSettings() async {
    final result = await showModalBottomSheet<Map<String, String>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _SessionSettingsSheet(
        currentName: _name,
        modes: _modes,
        currentMode: _mode,
        canAttach:
            widget.session.agent == 'claude' && widget.session.runner == 'local',
        isTmux: widget.session.runner == 'tmux',
      ),
    );
    if (result == null) return;
    if (result['action'] == 'attach') {
      await _attachClaudeSession();
      return;
    }
    if (result['action'] == 'voice') {
      await _pickVoice();
      return;
    }
    if (result['action'] == 'tmux-attach') {
      await _showTmuxAttach();
      return;
    }
    final newName = result['name'];
    final newMode = result['mode'];
    final nameChanged = newName != null && newName != _name;
    final modeChanged = newMode != null && newMode != _mode;
    if (!nameChanged && !modeChanged) return;
    final prevName = _name, prevMode = _mode;
    setState(() {
      if (nameChanged) _name = newName;
      if (modeChanged) _mode = newMode;
    });
    try {
      await _api.updateSession(
        widget.session.id,
        name: nameChanged ? newName : null,
        mode: modeChanged ? newMode : null,
      );
      _toast(nameChanged && modeChanged
          ? 'Name and mode updated'
          : nameChanged
              ? 'Name updated'
              : 'Mode: ${_modeLabel(newMode!)}');
    } catch (e) {
      if (mounted) setState(() { _name = prevName; _mode = prevMode; });
      _toast('Update failed: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  // Attach this session to an existing Claude Code session and resume it by voice.
  Future<void> _attachClaudeSession() async {
    List<Map<String, dynamic>> list;
    try {
      list = await _api.claudeSessions(widget.session.id);
    } catch (e) {
      _toast('Couldn\'t load Claude sessions: ${e.toString().replaceFirst('Exception: ', '')}');
      return;
    }
    if (!mounted) return;
    if (list.isEmpty) {
      _toast('No saved Claude session for this project.');
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _ClaudeSessionsSheet(sessions: list),
    );
    if (picked == null) return;
    try {
      await _api.updateSession(widget.session.id, claudeSessionId: picked);
      // The agent resumes that conversation; start the visible transcript fresh.
      setState(() {
        _messages
          ..clear()
          ..add(Message('activity',
              '🔗 Connected to the Claude session — the agent will remember the earlier conversation'));
      });
      _persist();
      _toBottom();
      _toast('Connected — this session continues on your next message.');
    } catch (e) {
      _toast('Couldn\'t connect: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  // Show how to reach a full (tmux) session live on the Mac and from the
  // Claude app via /remote-control.
  Future<void> _showTmuxAttach() async {
    Map<String, dynamic> info;
    try {
      info = await _api.tmuxAttach(widget.session.id);
    } catch (e) {
      _toast('Couldn\'t load: ${e.toString().replaceFirst('Exception: ', '')}');
      return;
    }
    if (!mounted) return;
    final cmd = (info['attachCmd'] as String?) ?? '';
    final steps = (info['remoteControlSteps'] as List?)?.cast<String>() ?? const [];
    await showDialog(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: VbColors.surface,
        title: const Text("Open on Mac / Claude app"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                    info['rcActive'] == true
                        ? Icons.cloud_done_rounded
                        : Icons.cloud_off_rounded,
                    size: 18,
                    color: info['rcActive'] == true
                        ? VbColors.accent
                        : VbColors.textMuted),
                const SizedBox(width: 8),
                Text(
                    info['rcActive'] == true
                        ? 'Remote Control: on'
                        : 'Remote Control: off',
                    style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: VbColors.textPrimary)),
              ],
            ),
            const SizedBox(height: 12),
            Text('Join this session live in your Mac terminal:',
                style: TextStyle(color: VbColors.textMuted, fontSize: 13)),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: VbColors.surfaceHigh,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: VbColors.border),
              ),
              child: SelectableText(cmd,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
            ),
            const SizedBox(height: 14),
            Text('To access it from the Claude app:',
                style: TextStyle(color: VbColors.textMuted, fontSize: 13)),
            const SizedBox(height: 6),
            for (var i = 0; i < steps.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text('${i + 1}. ${steps[i]}',
                    style: TextStyle(color: VbColors.textPrimary, fontSize: 13)),
              ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: cmd));
              _toast('Command copied');
            },
            child: const Text('Copy command'),
          ),
          FilledButton(
            onPressed: () async {
              final active = info['rcActive'] == true;
              Navigator.pop(context);
              try {
                await _api.tmuxRc(widget.session.id, active ? 'stop' : 'start');
                _toast(active
                    ? 'Remote Control stopped'
                    : 'Remote Control started');
              } catch (e) {
                _toast('Didn\'t work: ${e.toString().replaceFirst('Exception: ', '')}');
              }
            },
            child: Text(info['rcActive'] == true
                ? "Stop Remote Control"
                : 'Start Remote Control'),
          ),
        ],
      ),
    );
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    final color =
        VbColors.seededFor(_name.isEmpty ? widget.session.agent : _name);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 8,
        title: InkWell(
          onTap: _openSessionSettings,
          borderRadius: BorderRadius.circular(12),
          child: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [color, Color.lerp(color, Colors.black, 0.3)!],
                ),
              ),
              alignment: Alignment.center,
              child: Text(
                (_name.isEmpty ? '?' : _name.trim()[0]).toUpperCase(),
                style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: Colors.white),
              ),
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _name.isEmpty ? 'Untitled session' : _name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                    ),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          _subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: VbColors.textMuted,
                          ),
                        ),
                      ),
                      Icon(Icons.expand_more_rounded,
                          size: 15, color: VbColors.textMuted),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        ),
        actions: [
          IconButton(
            tooltip: _hideActivity ? 'Show activity' : 'Hide activity',
            onPressed: _toggleHideActivity,
            icon: Icon(_hideActivity
                ? Icons.visibility_off_outlined
                : Icons.visibility_outlined),
          ),
          IconButton(
            tooltip: 'Commands',
            onPressed: _busy ? null : _openPalette,
            icon: const Icon(Icons.bolt_outlined),
          ),
          _TalkButton(active: _talking, onTap: _toggleTalking),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          AnimatedSize(
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOutCubic,
            child: _talking ? _talkPanel() : const SizedBox(width: double.infinity),
          ),
          Expanded(
            child: _messages.isEmpty
                ? _emptyChat()
                : Builder(builder: (_) {
                    final rows = _rows();
                    return ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
                      itemCount: rows.length,
                      itemBuilder: (_, i) {
                        final r = rows[i];
                        return r is List<Message>
                            ? _ActivityGroup(items: r)
                            : _bubble(r as Message);
                      },
                    );
                  }),
          ),
          _composer(),
        ],
      ),
    );
  }

  Widget _emptyChat() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: VbColors.accent.withValues(alpha: 0.10),
                shape: BoxShape.circle,
                border:
                    Border.all(color: VbColors.accent.withValues(alpha: 0.25)),
              ),
              child: Icon(Icons.auto_awesome_outlined,
                  size: 32, color: VbColors.accent),
            ),
            const SizedBox(height: 20),
            Text(
              'Start a chat',
              style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: VbColors.textPrimary),
            ),
            const SizedBox(height: 8),
            Text(
              'Type a message, tap the mic, or turn on conversation mode.',
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 13.5, color: VbColors.textMuted, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }

  // ---- Talking mode panel: the breathing orb + state ----
  Widget _talkPanel() {
    // Real state: speaking while TTS audio plays, else thinking while a turn is
    // in flight, else listening (the resting state in talking mode).
    final _OrbState st = _ttsSpeaking
        ? _OrbState.speaking
        : _busy
            ? _OrbState.thinking
            : _OrbState.listening;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: VbColors.surface,
        border: Border(bottom: BorderSide(color: VbColors.border)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 22),
      child: Column(
        children: [
          GestureDetector(
            onTap: _toggleMute,
            behavior: HitTestBehavior.opaque,
            child: Opacity(
              opacity: _talkMuted ? 0.4 : 1,
              child: _VoiceOrb(state: st),
            ),
          ),
          const SizedBox(height: 16),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            child: Text(
              _talkMuted ? 'Muted' : st.label,
              key: ValueKey(_talkMuted ? 'muted' : st.label),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.2,
                color: _talkMuted ? VbColors.textMuted : st.color,
              ),
            ),
          ),
          const SizedBox(height: 14),
          // Clear mic on/off — mutes the mic WITHOUT ending the conversation.
          OutlinedButton.icon(
            onPressed: _toggleMute,
            icon: Icon(
              _talkMuted ? Icons.mic_off_rounded : Icons.mic_rounded,
              size: 18,
              color: _talkMuted ? VbColors.danger : VbColors.accent,
            ),
            label: Text(_talkMuted ? 'Turn on mic' : 'Turn off mic'),
            style: OutlinedButton.styleFrom(
              foregroundColor:
                  _talkMuted ? VbColors.danger : VbColors.textPrimary,
              side: BorderSide(
                  color: _talkMuted ? VbColors.danger : VbColors.border),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(VbRadius.chip)),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            _ttsSpeaking
                ? 'While speaking, tap the orb → cut in and talk right away'
                : 'Tap the orb → toggle the mic · tap the phone icon up top to finish',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, color: VbColors.textMuted),
          ),
        ],
      ),
    );
  }

  // Fold runs of consecutive '⚙︎' activity lines into one collapsible group so
  // the tool/bash chatter doesn't bury the conversation (like the web client).
  // A non-activity message is kept as-is; a run becomes a List<Message>.
  List<Object> _rows() {
    final rows = <Object>[];
    List<Message>? run;
    for (final m in _messages) {
      if (m.role == 'activity') {
        if (_hideActivity) continue; // toggle: drop tool/bash chatter entirely
        (run ??= <Message>[]).add(m);
      } else {
        if (run != null) { rows.add(run); run = null; }
        rows.add(m);
      }
    }
    if (run != null) rows.add(run);
    return rows;
  }

  Widget _bubble(Message m) {
    if (m.role == 'activity' || m.role == 'sys') {
      final isErr = m.role == 'sys';
      final c = isErr ? VbColors.danger : VbColors.textMuted;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: (isErr ? VbColors.danger : VbColors.surfaceHigh)
                  .withValues(alpha: isErr ? 0.12 : 1),
              borderRadius: BorderRadius.circular(VbRadius.chip),
              border: Border.all(
                color: isErr
                    ? VbColors.danger.withValues(alpha: 0.4)
                    : VbColors.border,
              ),
            ),
            child: Text(
              m.text,
              textAlign: TextAlign.center,
              style: VbTheme.mono(size: 11.5, color: c),
            ),
          ),
        ),
      );
    }

    final isMe = m.role == 'me';
    final radius = Radius.circular(VbRadius.bubble);
    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.82),
        decoration: BoxDecoration(
          color: isMe
              ? VbColors.accent.withValues(alpha: 0.16)
              : VbColors.surface,
          border: Border.all(
            color: isMe
                ? VbColors.accent.withValues(alpha: 0.38)
                : VbColors.border,
          ),
          borderRadius: BorderRadius.only(
            topLeft: radius,
            topRight: radius,
            bottomLeft: isMe ? radius : const Radius.circular(4),
            bottomRight: isMe ? const Radius.circular(4) : radius,
          ),
        ),
        child: m.text.isEmpty
            ? const _TypingDots()
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _MessageBody(text: m.text, isMe: isMe),
                  if (!isMe)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: InkWell(
                        onTap: () =>
                            _ttsMsg == m ? _stopSpeak() : _readAloud(m),
                        borderRadius: BorderRadius.circular(VbRadius.chip),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 3),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _ttsMsg == m
                                    ? Icons.stop_rounded
                                    : Icons.volume_up_rounded,
                                size: 16,
                                color: _ttsMsg == m
                                    ? VbColors.danger
                                    : VbColors.textMuted,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                _ttsMsg == m ? 'Stop' : 'Read aloud',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: _ttsMsg == m
                                      ? VbColors.danger
                                      : VbColors.textMuted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  Widget _composer() {
    return Container(
      decoration: BoxDecoration(
        color: VbColors.bg,
        border: Border(top: BorderSide(color: VbColors.border)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _CircleIconButton(
                icon: _listening ? Icons.mic : Icons.mic_none_rounded,
                active: _listening,
                onTap: _busy ? null : _listen,
                tooltip: 'Dictate',
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: VbColors.surface,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: VbColors.border),
                  ),
                  child: TextField(
                    controller: _input,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.send,
                    style: const TextStyle(fontSize: 15, height: 1.4),
                    onSubmitted: (t) {
                      if (t.trim().isNotEmpty) _send(t.trim());
                    },
                    decoration: const InputDecoration(
                      hintText: 'Type a message…',
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      contentPadding:
                          EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _SendButton(
                enabled: _canSend && !_busy,
                onTap: () {
                  final t = _input.text.trim();
                  if (t.isNotEmpty) _send(t);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Message rendering: a tiny, safe markdown-ish parser. Splits on fenced ```
// blocks and renders those in a monospace bordered container. Everything else
// is plain selectable text. No HTML, no network — text only.
// ---------------------------------------------------------------------------
class _MessageBody extends StatelessWidget {
  final String text;
  final bool isMe;
  const _MessageBody({required this.text, required this.isMe});

  @override
  Widget build(BuildContext context) {
    final segments = _split(text);
    if (segments.length == 1 && !segments.first.isCode) {
      return SelectableText(
        text,
        style: TextStyle(
            fontSize: 15, height: 1.45, color: VbColors.textPrimary),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < segments.length; i++)
          Padding(
            padding: EdgeInsets.only(top: i == 0 ? 0 : 8),
            child: segments[i].isCode
                ? _codeBlock(segments[i].text)
                : SelectableText(
                    segments[i].text,
                    style: TextStyle(
                        fontSize: 15,
                        height: 1.45,
                        color: VbColors.textPrimary),
                  ),
          ),
      ],
    );
  }

  Widget _codeBlock(String code) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: VbColors.bg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: VbColors.border),
      ),
      child: SelectableText(
        code,
        style: VbTheme.mono(size: 12.5, color: VbColors.textPrimary),
      ),
    );
  }

  static List<_Seg> _split(String text) {
    final out = <_Seg>[];
    final re = RegExp(r'```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```');
    var last = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > last) {
        final pre = text.substring(last, m.start).trim();
        if (pre.isNotEmpty) out.add(_Seg(pre, false));
      }
      final code = (m.group(1) ?? '').replaceAll(RegExp(r'\n$'), '');
      out.add(_Seg(code, true));
      last = m.end;
    }
    if (last < text.length) {
      final rest = text.substring(last).trim();
      if (rest.isNotEmpty) out.add(_Seg(rest, false));
    }
    if (out.isEmpty) out.add(_Seg(text, false));
    return out;
  }
}

class _Seg {
  final String text;
  final bool isCode;
  _Seg(this.text, this.isCode);
}

// ---------------------------------------------------------------------------
// Talking mode orb + helpers
// ---------------------------------------------------------------------------
enum _OrbState { listening, thinking, speaking }

extension _OrbStateX on _OrbState {
  String get label {
    switch (this) {
      case _OrbState.listening:
        return 'Listening';
      case _OrbState.thinking:
        return 'Thinking';
      case _OrbState.speaking:
        return 'Speaking';
    }
  }

  Color get color {
    switch (this) {
      case _OrbState.listening:
        return VbColors.accentBright;
      case _OrbState.thinking:
        return VbColors.warning;
      case _OrbState.speaking:
        return VbColors.info;
    }
  }
}

/// A large gradient circle that gently breathes, with a soft outer glow ring.
class _VoiceOrb extends StatefulWidget {
  final _OrbState state;
  const _VoiceOrb({required this.state});

  @override
  State<_VoiceOrb> createState() => _VoiceOrbState();
}

class _VoiceOrbState extends State<_VoiceOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 2))
        ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.state.color;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = Curves.easeInOut.transform(_c.value);
        final scale = 0.92 + t * 0.16;
        final glow = 0.25 + t * 0.30;
        return SizedBox(
          width: 168,
          height: 168,
          child: Center(
            child: Stack(
              alignment: Alignment.center,
              children: [
                // outer breathing halo
                Container(
                  width: 150 * scale,
                  height: 150 * scale,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: color.withValues(alpha: 0.08),
                  ),
                ),
                // core orb
                Container(
                  width: 116,
                  height: 116,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        Color.lerp(color, Colors.white, 0.25)!,
                        color,
                        Color.lerp(color, Colors.black, 0.40)!,
                      ],
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: color.withValues(alpha: glow),
                        blurRadius: 36,
                        spreadRadius: 6 * t,
                      ),
                    ],
                  ),
                  child: Icon(
                    widget.state == _OrbState.listening
                        ? Icons.mic_rounded
                        : widget.state == _OrbState.thinking
                            ? Icons.auto_awesome
                            : Icons.graphic_eq_rounded,
                    color: Colors.white,
                    size: 40,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// A folded run of '⚙︎' tool/activity lines. Collapsed by default (shows a count
/// and the latest action); tap to expand the full list. Keeps the transcript
/// clean for voice/eyes-free use.
class _ActivityGroup extends StatefulWidget {
  final List<Message> items;
  const _ActivityGroup({required this.items});

  @override
  State<_ActivityGroup> createState() => _ActivityGroupState();
}

class _ActivityGroupState extends State<_ActivityGroup> {
  bool _open = false;

  String _clean(String s) => s.replaceFirst('⚙︎ ', '').trim();

  @override
  Widget build(BuildContext context) {
    final items = widget.items;
    final last = items.isEmpty ? '' : _clean(items.last.text);
    final header = items.length == 1
        ? last
        : (_open ? '${items.length} actions' : '${items.length} actions · $last');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.9),
          child: Material(
            color: VbColors.surfaceHigh,
            borderRadius: BorderRadius.circular(VbRadius.chip),
            child: InkWell(
              borderRadius: BorderRadius.circular(VbRadius.chip),
              onTap: () => setState(() => _open = !_open),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _open
                              ? Icons.keyboard_arrow_down_rounded
                              : Icons.keyboard_arrow_right_rounded,
                          size: 16,
                          color: VbColors.textMuted,
                        ),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            header,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: VbTheme.mono(
                                size: 11.5, color: VbColors.textMuted),
                          ),
                        ),
                      ],
                    ),
                    if (_open)
                      Padding(
                        padding: const EdgeInsets.only(top: 6, left: 20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            for (final m in items)
                              Padding(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 1.5),
                                child: Text(
                                  _clean(m.text),
                                  style: VbTheme.mono(
                                      size: 11.5, color: VbColors.textMuted),
                                ),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Animated three-dot indicator shown while a reply streams in empty.
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1100))
    ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 16,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: List.generate(3, (i) {
              final phase = (_c.value + i * 0.2) % 1.0;
              final o = 0.3 + 0.7 * (0.5 + 0.5 * math.sin(phase * 2 * math.pi));
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2.5),
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: VbColors.textMuted.withValues(alpha: o),
                  ),
                ),
              );
            }),
          );
        },
      ),
    );
  }
}

/// Round mic button with an active (recording) accent state.
class _CircleIconButton extends StatelessWidget {
  final IconData icon;
  final bool active;
  final VoidCallback? onTap;
  final String tooltip;
  const _CircleIconButton({
    required this.icon,
    required this.active,
    required this.onTap,
    required this.tooltip,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: active
            ? VbColors.danger.withValues(alpha: 0.18)
            : VbColors.surface,
        shape: CircleBorder(
          side: BorderSide(
            color: active ? VbColors.danger.withValues(alpha: 0.5) : VbColors.border,
          ),
        ),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(11),
            child: Icon(
              icon,
              size: 22,
              color: active ? VbColors.danger : VbColors.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}

/// The send button: accent-filled when there's something to send.
class _SendButton extends StatelessWidget {
  final bool enabled;
  final VoidCallback onTap;
  const _SendButton({required this.enabled, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: enabled ? 1 : 0.92,
      duration: const Duration(milliseconds: 160),
      child: Material(
        color: enabled ? VbColors.accent : VbColors.surfaceHigh,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(11),
            child: Icon(
              Icons.arrow_upward_rounded,
              size: 22,
              color: enabled ? const Color(0xFF06210C) : VbColors.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}

/// Talking-mode toggle in the app bar (call / hang-up).
class _TalkButton extends StatelessWidget {
  final bool active;
  final VoidCallback onTap;
  const _TalkButton({required this.active, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: active ? 'Stop talking' : 'Conversation mode',
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Material(
          color: active
              ? VbColors.danger.withValues(alpha: 0.16)
              : VbColors.accent.withValues(alpha: 0.14),
          shape: CircleBorder(
            side: BorderSide(
              color: active
                  ? VbColors.danger.withValues(alpha: 0.5)
                  : VbColors.accent.withValues(alpha: 0.4),
            ),
          ),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Icon(
                active ? Icons.call_end_rounded : Icons.graphic_eq_rounded,
                size: 20,
                color: active ? VbColors.danger : VbColors.accent,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Searchable list of the project's commands; returns the chosen item's value.
class _CommandSheet extends StatefulWidget {
  final List<Map<String, dynamic>> groups;
  const _CommandSheet({required this.groups});

  @override
  State<_CommandSheet> createState() => _CommandSheetState();
}

class _CommandSheetState extends State<_CommandSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.toLowerCase();
    final tiles = <Widget>[];
    for (final g in widget.groups) {
      final items = ((g['items'] as List?) ?? const [])
          .map((e) => e as Map<String, dynamic>)
          .where((it) {
        final label = (it['label'] ?? '').toString().toLowerCase();
        final value = (it['value'] ?? '').toString().toLowerCase();
        return q.isEmpty || label.contains(q) || value.contains(q);
      }).toList();
      if (items.isEmpty) continue;
      tiles.add(Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 6),
        child: Text(
          '${g['label']}'.toUpperCase(),
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
            color: VbColors.textMuted,
          ),
        ),
      ));
      for (final it in items) {
        tiles.add(
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
            child: Material(
              color: Colors.transparent,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => Navigator.pop(
                    context, (it['value'] ?? it['label']).toString()),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
                  child: Row(
                    children: [
                      Icon(Icons.chevron_right_rounded,
                          size: 18, color: VbColors.accent),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${it['label']}',
                              style: TextStyle(
                                  fontSize: 14.5,
                                  fontWeight: FontWeight.w600,
                                  color: VbColors.textPrimary),
                            ),
                            if (it['hint'] != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Text(
                                  '${it['hint']}',
                                  style: VbTheme.mono(
                                      size: 11.5, color: VbColors.textMuted),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      }
    }
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        decoration: BoxDecoration(
          color: VbColors.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
        height: MediaQuery.of(context).size.height * 0.72,
        child: Column(
          children: [
            const _Grabber(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Row(
                children: [
                  Icon(Icons.bolt_outlined, color: VbColors.accent),
                  const SizedBox(width: 8),
                  const Text(
                    'Commands',
                    style: TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
              child: TextField(
                autofocus: false, // don't pop the keyboard on open (shrinks the list, hard to dismiss)
                onChanged: (v) => setState(() => _q = v),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Search commands…',
                ),
              ),
            ),
            Expanded(
              child: tiles.isEmpty
                  ? Center(
                      child: Text('No matches',
                          style: TextStyle(color: VbColors.textMuted)))
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 16),
                      children: tiles),
            ),
          ],
        ),
      ),
    );
  }
}

/// Session settings: pick how autonomous the agent is (the "mode").
/// Tapping a mode selects it and closes the sheet (returns the mode id).
class _SessionSettingsSheet extends StatefulWidget {
  final String currentName;
  final List<Map<String, dynamic>> modes;
  final String currentMode;
  final bool canAttach;
  final bool isTmux;
  const _SessionSettingsSheet({
    required this.currentName,
    required this.modes,
    required this.currentMode,
    this.canAttach = false,
    this.isTmux = false,
  });

  @override
  State<_SessionSettingsSheet> createState() => _SessionSettingsSheetState();
}

class _SessionSettingsSheetState extends State<_SessionSettingsSheet> {
  late final TextEditingController _nameCtl =
      TextEditingController(text: widget.currentName);
  late String _mode = widget.currentMode;

  @override
  void dispose() {
    _nameCtl.dispose();
    super.dispose();
  }

  void _save() => Navigator.pop(context, <String, String>{
        'name': _nameCtl.text.trim(),
        'mode': _mode,
      });

  IconData _icon(String id) {
    switch (id) {
      case 'full':
        return Icons.bolt_rounded;
      case 'autoEdit':
      case 'acceptEdits':
        return Icons.edit_note_rounded;
      case 'ask':
      case 'default':
        return Icons.verified_user_outlined;
      default:
        return Icons.tune_rounded;
    }
  }

  String _hint(String id) {
    switch (id) {
      case 'full':
        return 'Full-auto — never asks permission, runs uninterrupted';
      case 'autoEdit':
      case 'acceptEdits':
        return 'Auto-approves file edits';
      case 'ask':
      case 'default':
        return 'Asks permission for every action';
      default:
        return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: VbColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
              16, 0, 16, MediaQuery.of(context).viewInsets.bottom + 18),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Center(child: _Grabber()),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: VbColors.accent.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(11),
                      ),
                      child: Icon(Icons.tune_rounded,
                          size: 20, color: VbColors.accent),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Text('Session settings',
                          style: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                              letterSpacing: -0.2)),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 6),
                  child: Text('NAME',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.6,
                          color: VbColors.textMuted)),
                ),
                TextField(
                  controller: _nameCtl,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _save(),
                  decoration: const InputDecoration(hintText: 'Session name'),
                ),
                const SizedBox(height: 18),
                Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 4),
                  child: Text('AUTONOMY MODE',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.6,
                          color: VbColors.textMuted)),
                ),
                if (widget.modes.isEmpty)
                  Padding(
                    padding: EdgeInsets.symmetric(vertical: 18),
                    child: Text('Couldn\'t load mode info for this session.',
                        style: TextStyle(color: VbColors.textMuted)),
                  )
                else
                  for (final m in widget.modes)
                    _modeTile(context, (m['id'] ?? '').toString(),
                        (m['label'] ?? m['id'] ?? '').toString()),
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: VbColors.surfaceHigh,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: VbColors.border),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.info_outline_rounded,
                          size: 16, color: VbColors.textMuted),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Permission prompts can\'t open from the phone; "full-auto" mode is best for uninterrupted runs.',
                          style: TextStyle(
                              fontSize: 12,
                              color: VbColors.textMuted,
                              height: 1.4),
                        ),
                      ),
                    ],
                  ),
                ),
                if (widget.canAttach) ...[
                  SizedBox(height: 18),
                  Padding(
                    padding: EdgeInsets.only(left: 4, bottom: 6),
                    child: Text('CLAUDE SESSION',
                        style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.6,
                            color: VbColors.textMuted)),
                  ),
                  Material(
                    color: VbColors.surfaceHigh,
                    borderRadius: BorderRadius.circular(14),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => Navigator.pop(
                          context, <String, String>{'action': 'attach'}),
                      child: Container(
                        padding: EdgeInsets.symmetric(
                            horizontal: 14, vertical: 13),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: VbColors.border),
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.history_rounded,
                                size: 22, color: VbColors.accent),
                            SizedBox(width: 13),
                            Expanded(
                              child: Text(
                                'Connect to the CLI/desktop session & continue by voice',
                                style: TextStyle(
                                    fontSize: 14.5,
                                    fontWeight: FontWeight.w600,
                                    color: VbColors.textPrimary),
                              ),
                            ),
                            Icon(Icons.chevron_right_rounded,
                                color: VbColors.textMuted),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
                if (widget.isTmux) ...[
                  SizedBox(height: 18),
                  Padding(
                    padding: EdgeInsets.only(left: 4, bottom: 6),
                    child: Text('FULL SESSION',
                        style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.6,
                            color: VbColors.textMuted)),
                  ),
                  Material(
                    color: VbColors.surfaceHigh,
                    borderRadius: BorderRadius.circular(14),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => Navigator.pop(
                          context, <String, String>{'action': 'tmux-attach'}),
                      child: Container(
                        padding:
                            EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: VbColors.border),
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.terminal_rounded,
                                size: 22, color: VbColors.accent),
                            SizedBox(width: 13),
                            Expanded(
                              child: Text("Open on Mac / access from the Claude app",
                                  style: TextStyle(
                                      fontSize: 14.5,
                                      fontWeight: FontWeight.w600,
                                      color: VbColors.textPrimary)),
                            ),
                            Icon(Icons.chevron_right_rounded,
                                color: VbColors.textMuted),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
                SizedBox(height: 18),
                Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 6),
                  child: Text('VOICE',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.6,
                          color: VbColors.textMuted)),
                ),
                Material(
                  color: VbColors.surfaceHigh,
                  borderRadius: BorderRadius.circular(14),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () => Navigator.pop(
                        context, <String, String>{'action': 'voice'}),
                    child: Container(
                      padding:
                          EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: VbColors.border),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.record_voice_over_rounded,
                              size: 22, color: VbColors.accent),
                          SizedBox(width: 13),
                          Expanded(
                            child: Text('Choose the talking voice',
                                style: TextStyle(
                                    fontSize: 14.5,
                                    fontWeight: FontWeight.w600,
                                    color: VbColors.textPrimary)),
                          ),
                          Icon(Icons.chevron_right_rounded,
                              color: VbColors.textMuted),
                        ],
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _save,
                  icon: const Icon(Icons.check_rounded),
                  label: const Text('Save'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _modeTile(BuildContext context, String id, String label) {
    final selected = id == _mode;
    final hint = _hint(id);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Material(
        color: selected
            ? VbColors.accent.withValues(alpha: 0.10)
            : VbColors.surfaceHigh,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => setState(() => _mode = id),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: selected
                    ? VbColors.accent.withValues(alpha: 0.5)
                    : VbColors.border,
              ),
            ),
            child: Row(
              children: [
                Icon(_icon(id),
                    size: 22,
                    color: selected ? VbColors.accent : VbColors.textMuted),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label,
                          style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: VbColors.textPrimary)),
                      if (hint.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(hint,
                              style: TextStyle(
                                  fontSize: 12, color: VbColors.textMuted)),
                        ),
                    ],
                  ),
                ),
                if (selected)
                  Icon(Icons.check_circle_rounded,
                      size: 20, color: VbColors.accent),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Picker for an existing Claude Code session to attach & resume by voice.
class _ClaudeSessionsSheet extends StatelessWidget {
  final List<Map<String, dynamic>> sessions;
  const _ClaudeSessionsSheet({required this.sessions});

  String _ago(int ms) {
    if (ms <= 0) return '';
    final d =
        DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) return '${d.inHours} hr ago';
    return '${d.inDays} days ago';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: VbColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      height: MediaQuery.of(context).size.height * 0.7,
      child: Column(
        children: [
          const _Grabber(),
          Padding(
            padding: EdgeInsets.fromLTRB(20, 4, 20, 10),
            child: Row(
              children: [
                Icon(Icons.history_rounded, color: VbColors.accent),
                SizedBox(width: 8),
                Expanded(
                  child: Text('Claude sessions',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
              itemCount: sessions.length,
              itemBuilder: (_, i) {
                final s = sessions[i];
                final title = (s['title'] ?? '').toString().trim();
                final ms = (s['mtime'] is num) ? (s['mtime'] as num).toInt() : 0;
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Material(
                    color: VbColors.surfaceHigh,
                    borderRadius: BorderRadius.circular(12),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(12),
                      onTap: () =>
                          Navigator.pop(context, (s['id'] ?? '').toString()),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: VbColors.border),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title.isEmpty ? '(untitled session)' : title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: 14.5,
                                  color: VbColors.textPrimary,
                                  height: 1.3),
                            ),
                            const SizedBox(height: 4),
                            Text(_ago(ms),
                                style: VbTheme.mono(
                                    size: 11, color: VbColors.textMuted)),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Small grabber handle for bottom sheets.
class _Grabber extends StatelessWidget {
  const _Grabber();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 6),
      width: 40,
      height: 4,
      decoration: BoxDecoration(
        color: VbColors.border,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}
