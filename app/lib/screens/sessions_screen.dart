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

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      final s = await widget.api.createSession(
        name: _name.text.trim().isEmpty ? 'Yeni sohbet' : _name.text.trim(),
        agent: _agent ?? 'claude',
        mode: _mode ?? '',
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
