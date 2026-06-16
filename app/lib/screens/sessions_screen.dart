import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../settings.dart';
import '../theme.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';

/// Home: the list of conversations (like the web UI's session list).
class SessionsScreen extends StatefulWidget {
  final AppSettings settings;
  const SessionsScreen({super.key, required this.settings});

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen>
    with WidgetsBindingObserver {
  late final Api _api = Api(widget.settings);
  List<Session> _sessions = [];
  List<dynamic> _agents = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Cross-delete: refresh when the app returns, so a session deleted on
    // another client (its tmux already killed) disappears here too.
    if (state == AppLifecycleState.resumed) _refresh();
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
      backgroundColor: Colors.transparent,
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
        titleSpacing: 18,
        title: Row(
          children: [
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(9),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [VbColors.accentBright, VbColors.accentDim],
                ),
              ),
              child: const Icon(Icons.graphic_eq_rounded,
                  size: 18, color: Color(0xFF06210C)),
            ),
            const SizedBox(width: 10),
            const Text('voicebridge'),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: 'Yenile',
          ),
          IconButton(
            onPressed: _openSettings,
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'Ayarlar',
          ),
          const SizedBox(width: 4),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add),
        label: const Text('Yeni sohbet'),
      ),
      body: RefreshIndicator(
        color: VbColors.accent,
        backgroundColor: VbColors.surface,
        onRefresh: _refresh,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return _StateView(
        icon: Icons.cloud_off_rounded,
        iconColor: VbColors.danger,
        title: 'Köprüye ulaşılamadı',
        message: _error!,
        actionLabel: 'Köprü ayarları',
        onAction: _openSettings,
      );
    }
    if (_sessions.isEmpty) {
      return _StateView(
        icon: Icons.forum_outlined,
        iconColor: VbColors.accent,
        title: 'Henüz oturum yok',
        message: 'Yeni bir sohbet başlatarak Claude Code ile konuşmaya başla.',
        actionLabel: 'Yeni sohbet',
        onAction: _create,
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 96),
      itemCount: _sessions.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) => _sessionCard(_sessions[i]),
    );
  }

  Widget _sessionCard(Session s) {
    final color = VbColors.seededFor(s.name.isEmpty ? s.agent : s.name);
    final initial = (s.name.isEmpty ? '?' : s.name.trim()[0]).toUpperCase();
    return Dismissible(
      key: ValueKey(s.id),
      direction: DismissDirection.endToStart,
      background: Container(
        decoration: BoxDecoration(
          color: VbColors.danger.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(VbRadius.card),
          border: Border.all(color: VbColors.danger.withValues(alpha: 0.4)),
        ),
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 22),
        child: Icon(Icons.delete_outline, color: VbColors.danger),
      ),
      confirmDismiss: (_) async {
        await _delete(s);
        return false; // we mutate the list ourselves
      },
      child: Material(
        color: VbColors.surface,
        borderRadius: BorderRadius.circular(VbRadius.card),
        child: InkWell(
          borderRadius: BorderRadius.circular(VbRadius.card),
          onTap: () => _open(s),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(VbRadius.card),
              border: Border.all(color: VbColors.border),
            ),
            child: Row(
              children: [
                Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(13),
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        color,
                        Color.lerp(color, Colors.black, 0.28)!,
                      ],
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    initial,
                    style: const TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                      color: Colors.white,
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.name.isEmpty ? 'İsimsiz oturum' : s.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: VbColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          if (s.agentLabel.isNotEmpty)
                            _MetaChip(label: s.agentLabel, icon: Icons.smart_toy_outlined),
                          if (s.mode.isNotEmpty) _MetaChip(label: s.mode),
                          _MetaChip(
                            label: s.runner == 'cloud' ? 'cloud' : 'local',
                            icon: s.runner == 'cloud'
                                ? Icons.cloud_outlined
                                : Icons.computer_outlined,
                            accent: s.runner == 'cloud',
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Icon(Icons.chevron_right, color: VbColors.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A small pill chip used in session subtitles.
class _MetaChip extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool accent;
  const _MetaChip({required this.label, this.icon, this.accent = false});

  @override
  Widget build(BuildContext context) {
    final fg = accent ? VbColors.accent : VbColors.textMuted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: accent
            ? VbColors.accent.withValues(alpha: 0.12)
            : VbColors.surfaceHigh,
        borderRadius: BorderRadius.circular(VbRadius.chip),
        border: Border.all(
          color: accent
              ? VbColors.accent.withValues(alpha: 0.35)
              : VbColors.border,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: fg),
            const SizedBox(width: 5),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: fg,
            ),
          ),
        ],
      ),
    );
  }
}

/// Reusable, intentional empty/error placeholder.
class _StateView extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;
  const _StateView({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 32),
      children: [
        const SizedBox(height: 120),
        Center(
          child: Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              color: iconColor.withValues(alpha: 0.12),
              shape: BoxShape.circle,
              border: Border.all(color: iconColor.withValues(alpha: 0.3)),
            ),
            child: Icon(icon, size: 38, color: iconColor),
          ),
        ),
        const SizedBox(height: 22),
        Text(
          title,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w700,
            color: VbColors.textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14, color: VbColors.textMuted, height: 1.4),
        ),
        const SizedBox(height: 24),
        Center(
          child: FilledButton(onPressed: onAction, child: Text(actionLabel)),
        ),
      ],
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
  bool _fullSession = false; // Tat Y: run a full interactive claude in tmux

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
        runner: (_fullSession && (_agent ?? 'claude') == 'claude') ? 'tmux' : 'local',
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
    return Container(
      decoration: BoxDecoration(
        color: VbColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 0,
          bottom: MediaQuery.of(context).viewInsets.bottom + 22,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Center(child: _Grabber()),
            const SizedBox(height: 10),
            Row(
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: VbColors.accent.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Icon(Icons.add_comment_outlined,
                      size: 20, color: VbColors.accent),
                ),
                const SizedBox(width: 12),
                const Text('Yeni oturum',
                    style: TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.2)),
              ],
            ),
            const SizedBox(height: 20),
            _fieldLabel('İsim'),
            const SizedBox(height: 7),
            TextField(
              controller: _name,
              decoration: const InputDecoration(hintText: 'Yeni sohbet'),
            ),
            const SizedBox(height: 16),
            _fieldLabel('Agent'),
            const SizedBox(height: 7),
            DropdownButtonFormField<String>(
              value: _agent,
              isExpanded: true,
              borderRadius: BorderRadius.circular(VbRadius.field),
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
            const SizedBox(height: 16),
            _fieldLabel('Mod'),
            const SizedBox(height: 7),
            DropdownButtonFormField<String>(
              value: _mode,
              isExpanded: true,
              borderRadius: BorderRadius.circular(VbRadius.field),
              items: [
                for (final m in _modes)
                  DropdownMenuItem(
                      value: m['id'] as String, child: Text('${m['label']}')),
              ],
              onChanged: (v) => setState(() => _mode = v),
            ),
            const SizedBox(height: 16),
            _fieldLabel('Proje klasörü'),
            const SizedBox(height: 7),
            InkWell(
              onTap: _busy ? null : _browse,
              borderRadius: BorderRadius.circular(VbRadius.field),
              child: InputDecorator(
                decoration: const InputDecoration(
                  suffixIcon: Icon(Icons.folder_open_outlined),
                ),
                child: Text(
                  _projectDir.isEmpty ? '(varsayılan)' : _projectDir,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _projectDir.isEmpty
                        ? VbColors.textMuted
                        : VbColors.textPrimary,
                  ),
                ),
              ),
            ),
            if ((_agent ?? 'claude') == 'claude') ...[
              const SizedBox(height: 16),
              Material(
                color: VbColors.surfaceHigh,
                borderRadius: BorderRadius.circular(VbRadius.field),
                child: InkWell(
                  borderRadius: BorderRadius.circular(VbRadius.field),
                  onTap: () => setState(() => _fullSession = !_fullSession),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
                    child: Row(
                      children: [
                        Icon(Icons.terminal_rounded,
                            size: 20, color: VbColors.accent),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Tam oturum (tmux)',
                                  style: TextStyle(
                                      fontSize: 14.5,
                                      fontWeight: FontWeight.w600,
                                      color: VbColors.textPrimary)),
                              const SizedBox(height: 2),
                              Text("Mac'ten de gir, /remote-control çalışır",
                                  style: TextStyle(
                                      fontSize: 11.5,
                                      color: VbColors.textMuted)),
                            ],
                          ),
                        ),
                        Switch(
                            value: _fullSession,
                            onChanged: (v) =>
                                setState(() => _fullSession = v)),
                      ],
                    ),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _busy ? null : _submit,
              icon: _busy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: Color(0xFF06210C)))
                  : const Icon(Icons.check_rounded),
              label: Text(_busy ? 'Oluşturuluyor…' : 'Oluştur'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _fieldLabel(String text) => Padding(
        padding: const EdgeInsets.only(left: 4),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: VbColors.textPrimary,
          ),
        ),
      );
}

/// Small grabber handle for bottom sheets.
class _Grabber extends StatelessWidget {
  const _Grabber();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 12, bottom: 4),
      width: 40,
      height: 4,
      decoration: BoxDecoration(
        color: VbColors.border,
        borderRadius: BorderRadius.circular(2),
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
        icon: const Icon(Icons.check_rounded),
        label: const Text('Bu klasörü seç'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.error_outline_rounded,
                            size: 40, color: VbColors.danger),
                        const SizedBox(height: 14),
                        Text(_error!,
                            textAlign: TextAlign.center,
                            style: TextStyle(color: VbColors.textMuted)),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 90),
                  children: [
                    for (final d in _dirs)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Material(
                          color: Colors.transparent,
                          borderRadius: BorderRadius.circular(12),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(12),
                            onTap: () => _load(_join(d)),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 13),
                              child: Row(
                                children: [
                                  Icon(Icons.folder_rounded,
                                      size: 22, color: VbColors.accent),
                                  const SizedBox(width: 13),
                                  Expanded(
                                    child: Text(d,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                            fontSize: 15,
                                            color: VbColors.textPrimary)),
                                  ),
                                  Icon(Icons.chevron_right_rounded,
                                      color: VbColors.textMuted),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    if (_dirs.isEmpty)
                      Padding(
                        padding: EdgeInsets.all(40),
                        child: Center(
                          child: Text('Alt klasör yok',
                              style: TextStyle(color: VbColors.textMuted)),
                        ),
                      ),
                  ],
                ),
    );
  }
}
