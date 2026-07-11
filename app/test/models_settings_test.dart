import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:voicebridge_app/models.dart';
import 'package:voicebridge_app/settings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Session', () {
    test('parses bridge JSON with safe defaults', () {
      final session = Session.fromJson({
        'id': 's1',
        'name': 'Phone run',
        'agent': 'codex',
        'agentLabel': 'Codex',
        'projectDir': '/repo',
        'mode': 'auto',
      });

      expect(session.id, 's1');
      expect(session.runner, 'local');
      expect(session.subtitle, 'Codex · auto · local');
    });

    test('marks cloud runner in the subtitle', () {
      final session = Session.fromJson({
        'id': 's2',
        'agentLabel': 'Claude',
        'mode': 'full',
        'runner': 'cloud',
      });

      expect(session.subtitle, 'Claude · full · ☁️ cloud');
    });
  });

  group('Message', () {
    test('round-trips JSON and supplies defaults', () {
      final message = Message.fromJson({'role': 'me', 'text': 'run tests'});
      expect(message.toJson(), {'role': 'me', 'text': 'run tests'});

      final fallback = Message.fromJson({});
      expect(fallback.role, 'sys');
      expect(fallback.text, '');
    });
  });

  group('AppSettings', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('normalizes the bridge base URL', () {
      final settings = AppSettings(baseUrl: ' https://mac.tailnet.ts.net/// ');
      expect(settings.isConfigured, isTrue);
      expect(settings.base, 'https://mac.tailnet.ts.net');
    });

    test('persists trimmed bridge settings', () async {
      final settings = AppSettings(
        baseUrl: ' https://mac.tailnet.ts.net/ ',
        token: ' secret-token ',
      );

      await settings.save();
      final loaded = await AppSettings.load();

      expect(loaded.baseUrl, 'https://mac.tailnet.ts.net/');
      expect(loaded.base, 'https://mac.tailnet.ts.net');
      expect(loaded.token, 'secret-token');
    });
  });
}
