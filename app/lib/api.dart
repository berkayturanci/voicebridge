import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'models.dart';
import 'settings.dart';

/// Thin client for the voicebridge HTTP API. The bridge is the backend; this
/// app is just a native front-end, so the contract matches the web UI exactly.
class Api {
  final AppSettings settings;
  Api(this.settings);

  Map<String, String> _headers([Map<String, String>? extra]) {
    final h = <String, String>{...?extra};
    if (settings.token.isNotEmpty) h['Authorization'] = 'Bearer ${settings.token}';
    return h;
  }

  Uri _u(String path) => Uri.parse('${settings.base}$path');

  /// GET /api/config — used to confirm reachability and read defaults.
  Future<Map<String, dynamic>> config() async {
    final r = await http.get(_u('/api/config'), headers: _headers());
    if (r.statusCode == 401) throw Exception('Token gerekli/geçersiz');
    if (r.statusCode != 200) throw Exception('Köprüye ulaşılamadı (${r.statusCode})');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// POST /api/tts — bridge-side (Piper) neural TTS. Returns WAV audio bytes.
  Future<Uint8List> ttsAudio(String text) async {
    final r = await http.post(
      _u('/api/tts'),
      headers: _headers({'Content-Type': 'application/json'}),
      body: jsonEncode({'text': text}),
    );
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Köprü sesi başarısız (${r.statusCode})');
    }
    return r.bodyBytes;
  }

  /// POST /api/handoff — pause this session for the phone and get a
  /// `claude --resume <id>` for the terminal (direction:'pc'), or reclaim it
  /// (direction:'phone'). Returns {resumeCmd, claudeSessionId, note, direction}.
  Future<Map<String, dynamic>> handoff(String sessionId,
      {String direction = 'pc'}) async {
    final r = await http.post(
      _u('/api/handoff'),
      headers: _headers({'Content-Type': 'application/json'}),
      body: jsonEncode({'sessionId': sessionId, 'direction': direction}),
    );
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Handoff başarısız (${r.statusCode})');
    }
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// GET /api/tmux-attach — full (tmux) session: returns {attachCmd, name,
  /// running, remoteControlSteps} for reaching it on the Mac / Claude app.
  Future<Map<String, dynamic>> tmuxAttach(String sessionId) async {
    final r = await http.get(_u('/api/tmux-attach?sessionId=$sessionId'),
        headers: _headers());
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Attach bilgisi alınamadı (${r.statusCode})');
    }
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// POST /api/tmux-rc — toggle Remote Control on a full (tmux) session.
  Future<Map<String, dynamic>> tmuxRc(String sessionId, String action) async {
    final r = await http.post(_u('/api/tmux-rc'),
        headers: _headers({'Content-Type': 'application/json'}),
        body: jsonEncode({'sessionId': sessionId, 'action': action}));
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Remote Control değişmedi (${r.statusCode})');
    }
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// GET /api/session-history — full transcript as {role,text} turns + byte
  /// offset to resume a watch from (#141).
  Future<Map<String, dynamic>> sessionHistory(String sessionId) async {
    final r = await http.get(_u('/api/session-history?sessionId=$sessionId'),
        headers: _headers());
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Geçmiş alınamadı (${r.statusCode})');
    }
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// GET /api/session-watch — long-lived NDJSON tail with auto-reconnect. Calls
  /// [onTurn] for every new {type:"turn",role,text}. Returns a [SessionWatch];
  /// call close() to stop.
  SessionWatch watchSession(
    String sessionId,
    int since, {
    required void Function(String role, String text) onTurn,
  }) =>
      SessionWatch(this, sessionId, since, onTurn);

  /// GET /api/sessions
  Future<List<Session>> sessions() async {
    final r = await http.get(_u('/api/sessions'), headers: _headers());
    if (r.statusCode == 401) throw Exception('Token geçersiz');
    if (r.statusCode != 200) throw Exception('Oturumlar alınamadı (${r.statusCode})');
    final data = jsonDecode(r.body) as Map<String, dynamic>;
    return (data['sessions'] as List)
        .map((e) => Session.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// POST /api/sessions
  Future<Session> createSession({
    required String name,
    required String agent,
    required String mode,
    String? projectDir,
    String runner = 'local',
  }) async {
    final r = await http.post(
      _u('/api/sessions'),
      headers: _headers({'Content-Type': 'application/json'}),
      body: jsonEncode({
        'name': name,
        'agent': agent,
        'mode': mode,
        if (projectDir != null && projectDir.isNotEmpty) 'projectDir': projectDir,
        'runner': runner,
      }),
    );
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Oturum oluşturulamadı (${r.statusCode})');
    }
    final data = jsonDecode(r.body) as Map<String, dynamic>;
    return Session.fromJson(data['session'] as Map<String, dynamic>);
  }

  /// POST /api/sessions/:id — update a session's name / mode / voice.
  /// Returns the refreshed session.
  Future<Session> updateSession(
    String id, {
    String? name,
    String? mode,
    bool? voice,
    String? claudeSessionId, // "" detaches, a uuid attaches & resumes that session
  }) async {
    final r = await http.post(
      _u('/api/sessions/$id'),
      headers: _headers({'Content-Type': 'application/json'}),
      body: jsonEncode({
        if (name != null) 'name': name,
        if (mode != null) 'mode': mode,
        if (voice != null) 'voice': voice,
        if (claudeSessionId != null) 'claudeSessionId': claudeSessionId,
      }),
    );
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Güncellenemedi (${r.statusCode})');
    }
    final data = jsonDecode(r.body) as Map<String, dynamic>;
    return Session.fromJson(data['session'] as Map<String, dynamic>);
  }

  /// GET /api/claude-sessions — existing Claude Code sessions for this session's
  /// project, to attach & resume. Returns [{id, title, mtime}].
  Future<List<Map<String, dynamic>>> claudeSessions(String sessionId) async {
    final uri = _u('/api/claude-sessions')
        .replace(queryParameters: {'sessionId': sessionId});
    final r = await http.get(uri, headers: _headers());
    if (r.statusCode != 200) return [];
    final data = jsonDecode(r.body) as Map<String, dynamic>;
    return ((data['sessions'] as List?) ?? const [])
        .map((e) => (e as Map<String, dynamic>))
        .toList();
  }

  /// GET /api/commands?sessionId= — the project's slash commands + npm scripts.
  /// Returns groups: [{label, items:[{label, value, hint?}]}].
  Future<List<Map<String, dynamic>>> commands(String sessionId) async {
    try {
      final uri = _u('/api/commands').replace(queryParameters: {'sessionId': sessionId});
      final r = await http.get(uri, headers: _headers());
      if (r.statusCode != 200) return [];
      final data = jsonDecode(r.body) as Map<String, dynamic>;
      return ((data['groups'] as List?) ?? const [])
          .map((e) => (e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// GET /api/browse — list subdirectories of [path] for the folder picker.
  /// Returns {path, parent, dirs:[...]}.
  Future<Map<String, dynamic>> browse(String? path, {String runner = 'local'}) async {
    final q = <String, String>{};
    if (path != null && path.isNotEmpty) q['path'] = path;
    if (runner == 'cloud') q['runner'] = 'cloud';
    final uri = _u('/api/browse').replace(queryParameters: q.isEmpty ? null : q);
    final r = await http.get(uri, headers: _headers());
    if (r.statusCode != 200) throw Exception('Gözatılamadı (${r.statusCode})');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// DELETE /api/sessions/:id
  Future<void> deleteSession(String id) async {
    final r = await http.delete(_u('/api/sessions/$id'), headers: _headers());
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Silinemedi (${r.statusCode})');
    }
  }

  /// POST /api/ask — streams newline-delimited JSON:
  ///   {"type":"delta","text":"..."} | {"type":"activity","text":"..."} | {"type":"error","error":"..."}
  /// Returns the full reply text; callbacks fire as the stream arrives.
  Future<String> ask({
    required String sessionId,
    required String text,
    required String mode,
    bool voice = false,
    required void Function(String delta) onDelta,
    void Function(String activity)? onActivity,
  }) async {
    final req = http.Request('POST', _u('/api/ask'));
    req.headers.addAll(_headers({'Content-Type': 'application/json'}));
    req.body = jsonEncode({
      'text': text,
      'sessionId': sessionId,
      'mode': mode,
      'voice': voice,
    });

    final streamed = await http.Client().send(req);
    if (streamed.statusCode == 401) throw Exception('Token geçersiz');
    if (streamed.statusCode == 429) throw Exception('Sunucu meşgul, birazdan tekrar dene');
    if (streamed.statusCode != 200) throw Exception('Hata (${streamed.statusCode})');

    final full = StringBuffer();
    var buf = '';
    await for (final chunk in streamed.stream.transform(utf8.decoder)) {
      buf += chunk;
      var idx = buf.indexOf('\n');
      while (idx >= 0) {
        final line = buf.substring(0, idx).trim();
        buf = buf.substring(idx + 1);
        idx = buf.indexOf('\n');
        if (line.isEmpty) continue;
        Map<String, dynamic> ev;
        try {
          ev = jsonDecode(line) as Map<String, dynamic>;
        } catch (_) {
          continue;
        }
        switch (ev['type']) {
          case 'delta':
            final t = (ev['text'] ?? '') as String;
            full.write(t);
            onDelta(t);
            break;
          case 'activity':
            onActivity?.call((ev['text'] ?? '') as String);
            break;
          case 'error':
            throw Exception((ev['error'] ?? 'Sunucu hatası') as String);
        }
      }
    }
    return full.toString();
  }

  String? _err(String body) {
    try {
      return (jsonDecode(body) as Map<String, dynamic>)['error'] as String?;
    } catch (_) {
      return null;
    }
  }
}

/// A self-reconnecting tail of /api/session-watch. Survives idle disconnects by
/// reconnecting from the last byte offset (no gaps, no duplicates). close() to stop.
class SessionWatch {
  final Api _api;
  final String sessionId;
  final void Function(String role, String text) onTurn;
  int _offset;
  http.Client? _client;
  bool _closed = false;

  SessionWatch(this._api, this.sessionId, this._offset, this.onTurn) {
    _connect();
  }

  void _connect() {
    if (_closed) return;
    final client = http.Client();
    _client = client;
    final req = http.Request('GET',
        _api._u('/api/session-watch?sessionId=$sessionId&since=$_offset'));
    req.headers.addAll(_api._headers());
    client.send(req).then((resp) {
      if (_closed) {
        client.close();
        return;
      }
      var buf = '';
      resp.stream.transform(utf8.decoder).listen((chunk) {
        buf += chunk;
        int nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          final line = buf.substring(0, nl);
          buf = buf.substring(nl + 1);
          if (line.trim().isEmpty) continue;
          try {
            final o = jsonDecode(line) as Map<String, dynamic>;
            if (o['offset'] is num) _offset = (o['offset'] as num).toInt();
            if (o['type'] == 'turn') {
              onTurn((o['role'] ?? '') as String, (o['text'] ?? '') as String);
            }
          } catch (_) {}
        }
      }, onError: (_) => _retry(), onDone: _retry, cancelOnError: true);
    }).catchError((_) {
      _retry();
    });
  }

  void _retry() {
    if (_closed) return;
    try {
      _client?.close();
    } catch (_) {}
    Future.delayed(const Duration(milliseconds: 1500), _connect);
  }

  void close() {
    _closed = true;
    try {
      _client?.close();
    } catch (_) {}
  }
}
