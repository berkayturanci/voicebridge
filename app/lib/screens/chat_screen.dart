import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../api.dart';
import '../models.dart';
import '../settings.dart';

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

  static const _locale = 'tr-TR';

  String get _histKey => 'vb_hist_${widget.session.id}';

  @override
  void initState() {
    super.initState();
    _tts.setLanguage(_locale);
    _tts.awaitSpeakCompletion(true);
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
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.session.name),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(20),
          child: Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(widget.session.subtitle,
                style: const TextStyle(fontSize: 12, color: Colors.white70)),
          ),
        ),
        actions: [
          IconButton(
            tooltip: 'Komutlar',
            onPressed: _busy ? null : _openPalette,
            icon: const Icon(Icons.bolt),
          ),
          IconButton(
            tooltip: _talking ? 'Konuşmayı durdur' : 'Konuşma modu',
            onPressed: _toggleTalking,
            icon: Icon(_talking ? Icons.call_end : Icons.call,
                color: _talking ? Colors.redAccent : null),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_talking) _talkBanner(),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(12),
              itemCount: _messages.length,
              itemBuilder: (_, i) => _bubble(_messages[i]),
            ),
          ),
          _composer(),
        ],
      ),
    );
  }

  Widget _talkBanner() {
    final state = _listening
        ? '🎙️ dinliyor…'
        : _busy
            ? '💭 düşünüyor…'
            : '🔊 konuşuyor…';
    return Container(
      width: double.infinity,
      color: Colors.green.withOpacity(0.15),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(state, textAlign: TextAlign.center),
    );
  }

  Widget _bubble(Message m) {
    if (m.role == 'activity' || m.role == 'sys') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Text(m.text,
            style: const TextStyle(fontSize: 12, color: Colors.grey)),
      );
    }
    final isMe = m.role == 'me';
    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.8),
        decoration: BoxDecoration(
          color: isMe ? Colors.green.shade700 : Colors.grey.shade800,
          borderRadius: BorderRadius.circular(12),
        ),
        child: SelectableText(m.text.isEmpty ? '…' : m.text),
      ),
    );
  }

  Widget _composer() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            IconButton(
              onPressed: _busy ? null : _listen,
              icon: Icon(_listening ? Icons.mic : Icons.mic_none,
                  color: _listening ? Colors.redAccent : null),
            ),
            Expanded(
              child: TextField(
                controller: _input,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.send,
                onSubmitted: (t) {
                  if (t.trim().isNotEmpty) _send(t.trim());
                },
                decoration: const InputDecoration(
                  hintText: 'Yaz ya da 🎤',
                  border: OutlineInputBorder(),
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                ),
              ),
            ),
            IconButton(
              onPressed: _busy
                  ? null
                  : () {
                      final t = _input.text.trim();
                      if (t.isNotEmpty) _send(t);
                    },
              icon: const Icon(Icons.send),
            ),
          ],
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
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Text('${g['label']}',
            style: const TextStyle(fontSize: 12, color: Colors.grey)),
      ));
      for (final it in items) {
        tiles.add(ListTile(
          dense: true,
          title: Text('${it['label']}'),
          subtitle: it['hint'] != null ? Text('${it['hint']}') : null,
          onTap: () =>
              Navigator.pop(context, (it['value'] ?? it['label']).toString()),
        ));
      }
    }
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: TextField(
                autofocus: true,
                onChanged: (v) => setState(() => _q = v),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Komut ara…',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            Expanded(
              child: tiles.isEmpty
                  ? const Center(child: Text('Eşleşme yok'))
                  : ListView(children: tiles),
            ),
          ],
        ),
      ),
    );
  }
}
