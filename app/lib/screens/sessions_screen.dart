import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../settings.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';

/// Home: the list of conversations (like the web UI's session list).
class SessionsScreen extends StatefulWidget {
  final AppSettings settings;
  const SessionsScreen({super.key, required this.settings});

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  late final Api _api = Api(widget.settings);
  List<Session> _sessions = [];
  List<dynamic> _agents = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final cfg = await _api.config();
      final s = await _api.sessions();
      setState(() {
        _agents = (cfg['agents'] as List?) ?? [];
        _sessions = s;
      });
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openSettings() async {
    final changed = await Navigator.push<bool>(
      context,
      MaterialPageRoute(
          builder: (_) => SettingsScreen(settings: widget.settings)),
    );
    if (changed == true) _refresh();
  }

  Future<void> _create() async {
    final created = await showModalBottomSheet<Session>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _NewSessionSheet(api: _api, agents: _agents),
    );
    if (created != null) {
      setState(() => _sessions = [..._sessions, created]);
      _open(created);
    }
  }

  void _open(Session s) {
    Navigator.push(
      context,
      MaterialPageRoute(
          builder: (_) => ChatScreen(settings: widget.settings, session: s)),
    );
  }

  Future<void> _delete(Session s) async {
    try {
      await _api.deleteSession(s.id);
      setState(() => _sessions.removeWhere((x) => x.id == s.id));
    } catch (e) {
      _toast(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _toast(String m) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('voicebridge'),
        actions: [
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
          IconButton(onPressed: _openSettings, icon: const Icon(Icons.settings)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add),
        label: const Text('Yeni'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return ListView(
        children: [
          const SizedBox(height: 80),
          const Icon(Icons.cloud_off, size: 48, color: Colors.grey),
          const SizedBox(height: 12),
          Center(child: Text('⚠️ $_error', textAlign: TextAlign.center)),
          const SizedBox(height: 16),
          Center(
            child: FilledButton(
                onPressed: _openSettings, child: const Text('Köprü ayarları')),
          ),
        ],
      );
    }
    if (_sessions.isEmpty) {
      return const Center(child: Text('Henüz oturum yok — ＋ Yeni'));
    }
    return ListView.separated(
      itemCount: _sessions.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final s = _sessions[i];
        return Dismissible(
          key: ValueKey(s.id),
          direction: DismissDirection.endToStart,
          background: Container(
            color: Colors.red,
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.only(right: 20),
            child: const Icon(Icons.delete, color: Colors.white),
          ),
          confirmDismiss: (_) async {
            await _delete(s);
            return false; // we mutate the list ourselves
          },
          child: ListTile(
            leading: CircleAvatar(child: Text(s.name.isEmpty ? '?' : s.name[0].toUpperCase())),
            title: Text(s.name),
            subtitle: Text(s.subtitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _open(s),
          ),
        );
      },
    );
  }
}

/// Bottom sheet to create a session: agent + mode + name.
class _NewSessionSheet extends StatefulWidget {
  final Api api;
  final List<dynamic> agents;
  const _NewSessionSheet({required this.api, required this.agents});

  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  final _name = TextEditingController();
  String? _agent;
  String? _mode;
  String _projectDir = '';
  bool _busy = false;

  List<dynamic> get _modes {
    final a = widget.agents.firstWhere((e) => e['id'] == _agent,
        orElse: () => null);
    return a == null ? [] : (a['modes'] as List? ?? []);
  }

  @override
  void initState() {
    super.initState();
    if (widget.agents.isNotEmpty) {
      _agent = widget.agents.first['id'] as String;
      _mode = widget.agents.first['defaultMode'] as String?;
    }
  }

  Future<void> _browse() async {
    final picked = await Navigator.push<String>(
      context,
      MaterialPageRoute(
          builder: (_) => _BrowseScreen(api: widget.api, start: _projectDir)),
    );
    if (picked != null) setState(() => _projectDir = picked);
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      final s = await widget.api.createSession(
        name: _name.text.trim().isEmpty ? 'Yeni sohbet' : _name.text.trim(),
        agent: _agent ?? 'claude',
        mode: _mode ?? '',
        projectDir: _projectDir.isEmpty ? null : _projectDir,
      );
      if (mounted) Navigator.pop(context, s);
    } catch (e) {
      setState(() => _busy = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', ''))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Yeni oturum',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          TextField(
            controller: _name,
            decoration: const InputDecoration(
                labelText: 'İsim', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            value: _agent,
            decoration: const InputDecoration(
                labelText: 'Agent', border: OutlineInputBorder()),
            items: [
              for (final a in widget.agents)
                DropdownMenuItem(
                  value: a['id'] as String,
                  enabled: a['available'] == true,
                  child: Text('${a['label']}'
                      '${a['available'] == true ? '' : ' (kurulu değil)'}'),
                ),
            ],
            onChanged: (v) => setState(() {
              _agent = v;
              final a = widget.agents.firstWhere((e) => e['id'] == v);
              _mode = a['defaultMode'] as String?;
            }),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            value: _mode,
            decoration: const InputDecoration(
                labelText: 'Mod', border: OutlineInputBorder()),
            items: [
              for (final m in _modes)
                DropdownMenuItem(
                    value: m['id'] as String, child: Text('${m['label']}')),
            ],
            onChanged: (v) => setState(() => _mode = v),
          ),
          const SizedBox(height: 12),
          InkWell(
            onTap: _busy ? null : _browse,
            child: InputDecorator(
              decoration: const InputDecoration(
                labelText: 'Proje klasörü',
                border: OutlineInputBorder(),
                suffixIcon: Icon(Icons.folder_open),
              ),
              child: Text(_projectDir.isEmpty ? '(varsayılan)' : _projectDir,
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: Text(_busy ? 'Oluşturuluyor…' : 'Oluştur'),
          ),
        ],
      ),
    );
  }
}

/// A simple folder browser backed by GET /api/browse. Tap a folder to descend,
/// use ⬆ for the parent, and "Bu klasörü seç" to return the current path.
class _BrowseScreen extends StatefulWidget {
  final Api api;
  final String start;
  const _BrowseScreen({required this.api, required this.start});

  @override
  State<_BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<_BrowseScreen> {
  String _path = '';
  String? _parent;
  List<String> _dirs = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load(widget.start.isEmpty ? null : widget.start);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await widget.api.browse(path);
      setState(() {
        _path = (data['path'] ?? '') as String;
        _parent = data['parent'] as String?;
        _dirs = ((data['dirs'] as List?) ?? const []).cast<String>();
      });
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _join(String dir) => _path.endsWith('/') ? '$_path$dir' : '$_path/$dir';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_path.isEmpty ? 'Klasör seç' : _path,
            style: const TextStyle(fontSize: 14)),
        actions: [
          if (_parent != null)
            IconButton(
                onPressed: () => _load(_parent),
                icon: const Icon(Icons.arrow_upward)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _path.isEmpty ? null : () => Navigator.pop(context, _path),
        icon: const Icon(Icons.check),
        label: const Text('Bu klasörü seç'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('⚠️ $_error'))
              : ListView(
                  children: [
                    for (final d in _dirs)
                      ListTile(
                        leading: const Icon(Icons.folder),
                        title: Text(d),
                        onTap: () => _load(_join(d)),
                      ),
                    if (_dirs.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: Text('Alt klasör yok')),
                      ),
                  ],
                ),
    );
  }
}
