import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../api.dart';
import '../models.dart';
import '../settings.dart';
import '../theme.dart';

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
  bool _canSend = false;

  static const _locale = 'tr-TR';

  String get _histKey => 'vb_hist_${widget.session.id}';

  @override
  void initState() {
    super.initState();
    _tts.setLanguage(_locale);
    _tts.awaitSpeakCompletion(true);
    _input.addListener(() {
      final can = _input.text.trim().isNotEmpty;
      if (can != _canSend) setState(() => _canSend = can);
    });
    _loadHistory();
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
    _stt.cancel();
    _tts.stop();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<bool> _ensureStt() async {
    if (_sttReady) return true;
    _sttReady = await _stt.initialize(
      onStatus: (s) {
        if (s == 'done' || s == 'notListening') {
          if (mounted) setState(() => _listening = false);
        }
      },
      onError: (e) {
        if (mounted) setState(() => _listening = false);
      },
    );
    if (!_sttReady && mounted) {
      _toast('Mikrofon izni yok veya ses tanıma kullanılamıyor.');
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

  // ---- Voice ----
  Future<void> _listen() async {
    if (!await _ensureStt()) return;
    setState(() => _listening = true);
    await _stt.listen(
      localeId: _locale,
      listenFor: const Duration(seconds: 30),
      pauseFor: const Duration(seconds: 3),
      onResult: (r) {
        if (r.finalResult) {
          final t = r.recognizedWords.trim();
          setState(() => _listening = false);
          if (t.isNotEmpty) _send(t);
        }
      },
    );
  }

  String _forSpeech(String text) {
    // Drop fenced code blocks and inline backticks so TTS isn't reading code.
    final noFences = text.replaceAll(RegExp(r'```[\s\S]*?```'), ' (kod) ');
    return noFences.replaceAll('`', '').trim();
  }

  Future<void> _speak(String text) async {
    final clean = _forSpeech(text);
    if (clean.isEmpty) return;
    await _tts.speak(clean);
  }

  void _toggleTalking() async {
    if (_talking) {
      setState(() => _talking = false);
      await _stt.stop();
      await _tts.stop();
      setState(() => _listening = false);
      return;
    }
    if (!await _ensureStt()) return;
    setState(() => _talking = true);
    _listen();
  }

  // ---- Send + stream ----
  Future<void> _send(String text) async {
    if (_busy) return;
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
        mode: widget.session.mode,
        onDelta: (d) {
          setState(() => reply.text += d);
          _toBottom();
        },
        onActivity: (a) {
          setState(() => _messages.add(Message('activity', '⚙︎ $a')));
          _toBottom();
        },
      );
      if (full.trim().isEmpty) setState(() => reply.text = '(boş cevap)');
      if (_talking && full.trim().isNotEmpty) {
        await _speak(full);
        if (_talking) _listen();
      }
    } catch (e) {
      setState(() => _messages
          .add(Message('sys', '⚠️ ${e.toString().replaceFirst('Exception: ', '')}')));
      if (_talking) _toggleTalking();
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
      _toast('Bu oturumda komut bulunamadı (cloud oturum olabilir).');
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _CommandSheet(groups: groups),
    );
    if (picked != null) {
      _input.text = picked;
      _input.selection =
          TextSelection.collapsed(offset: picked.length);
    }
  }

  void _toast(String m) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  @override
  Widget build(BuildContext context) {
    final color =
        VbColors.seededFor(widget.session.name.isEmpty ? widget.session.agent : widget.session.name);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 8,
        title: Row(
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
                (widget.session.name.isEmpty ? '?' : widget.session.name.trim()[0])
                    .toUpperCase(),
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
                    widget.session.name.isEmpty
                        ? 'İsimsiz oturum'
                        : widget.session.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                    ),
                  ),
                  Text(
                    widget.session.subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500,
                      color: VbColors.textMuted,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Komutlar',
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
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
                    itemCount: _messages.length,
                    itemBuilder: (_, i) => _bubble(_messages[i]),
                  ),
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
              child: const Icon(Icons.auto_awesome_outlined,
                  size: 32, color: VbColors.accent),
            ),
            const SizedBox(height: 20),
            const Text(
              'Sohbete başla',
              style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: VbColors.textPrimary),
            ),
            const SizedBox(height: 8),
            const Text(
              'Bir mesaj yaz, mikrofona dokun ya da konuşma modunu aç.',
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
    final _OrbState st = _busy && !_listening
        ? _OrbState.thinking
        : _listening
            ? _OrbState.listening
            : _OrbState.speaking;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: VbColors.surface,
        border: const Border(bottom: BorderSide(color: VbColors.border)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 22),
      child: Column(
        children: [
          _VoiceOrb(state: st),
          const SizedBox(height: 16),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            child: Text(
              st.label,
              key: ValueKey(st),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.2,
                color: st.color,
              ),
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Konuşma modu açık · durdurmak için telefon simgesine dokun',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, color: VbColors.textMuted),
          ),
        ],
      ),
    );
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
            : _MessageBody(text: m.text, isMe: isMe),
      ),
    );
  }

  Widget _composer() {
    return Container(
      decoration: const BoxDecoration(
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
                tooltip: 'Sesle yaz',
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
                      hintText: 'Mesaj yaz…',
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
        style: const TextStyle(
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
                    style: const TextStyle(
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
        return 'Dinliyor';
      case _OrbState.thinking:
        return 'Düşünüyor';
      case _OrbState.speaking:
        return 'Konuşuyor';
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
      message: active ? 'Konuşmayı durdur' : 'Konuşma modu',
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
          style: const TextStyle(
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
                      const Icon(Icons.chevron_right_rounded,
                          size: 18, color: VbColors.accent),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${it['label']}',
                              style: const TextStyle(
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
        decoration: const BoxDecoration(
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
                  const Icon(Icons.bolt_outlined, color: VbColors.accent),
                  const SizedBox(width: 8),
                  const Text(
                    'Komutlar',
                    style: TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
              child: TextField(
                autofocus: true,
                onChanged: (v) => setState(() => _q = v),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Komut ara…',
                ),
              ),
            ),
            Expanded(
              child: tiles.isEmpty
                  ? const Center(
                      child: Text('Eşleşme yok',
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
