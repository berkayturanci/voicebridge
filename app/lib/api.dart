import 'dart:convert';
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
  }) async {
    final r = await http.post(
      _u('/api/sessions/$id'),
      headers: _headers({'Content-Type': 'application/json'}),
      body: jsonEncode({
        if (name != null) 'name': name,
        if (mode != null) 'mode': mode,
        if (voice != null) 'voice': voice,
      }),
    );
    if (r.statusCode != 200) {
      throw Exception(_err(r.body) ?? 'Güncellenemedi (${r.statusCode})');
    }
    final data = jsonDecode(r.body) as Map<String, dynamic>;
    return Session.fromJson(data['session'] as Map<String, dynamic>);
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
