// Plain data models mirroring the bridge's JSON shapes.

class Session {
  final String id;
  final String name;
  final String agent;
  final String agentLabel;
  final String projectDir;
  final String mode;
  final String runner;
  final String? model;

  Session({
    required this.id,
    required this.name,
    required this.agent,
    required this.agentLabel,
    required this.projectDir,
    required this.mode,
    required this.runner,
    this.model,
  });

  factory Session.fromJson(Map<String, dynamic> j) => Session(
        id: j['id'] as String,
        name: (j['name'] ?? '') as String,
        agent: (j['agent'] ?? 'claude') as String,
        agentLabel: (j['agentLabel'] ?? j['agent'] ?? '') as String,
        projectDir: (j['projectDir'] ?? '') as String,
        mode: (j['mode'] ?? '') as String,
        runner: (j['runner'] ?? 'local') as String,
        model: j['model'] as String?,
      );

  String get subtitle {
    final parts = <String>[agentLabel];
    if (mode.isNotEmpty) parts.add(mode);
    parts.add(runner == 'cloud' ? '☁️ cloud' : 'local');
    return parts.join(' · ');
  }
}

/// A chat line. `role` is one of: me, claude, activity, sys.
class Message {
  final String role;
  String text;
  Message(this.role, this.text);
}
