import 'package:flutter_test/flutter_test.dart';
import 'package:voicebridge_app/models.dart';
import 'package:voicebridge_app/settings.dart';

void main() {
  test('AppSettings normalizes the bridge base URL', () {
    final settings = AppSettings(baseUrl: ' https://box.tailnet.ts.net/// ', token: 'abc');

    expect(settings.isConfigured, isTrue);
    expect(settings.base, 'https://box.tailnet.ts.net');
  });

  test('Session.fromJson applies defaults and builds a subtitle', () {
    final session = Session.fromJson({
      'id': 's1',
      'name': 'Default',
      'agent': 'claude',
      'agentLabel': 'Claude Code',
      'projectDir': '/repo',
      'mode': 'full',
    });

    expect(session.runner, 'local');
    expect(session.subtitle, 'Claude Code · full · local');
  });
}
