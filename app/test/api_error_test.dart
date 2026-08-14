import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:voicebridge_app/api.dart';
import 'package:voicebridge_app/settings.dart';

void main() {
  final settings = AppSettings(baseUrl: 'https://mac.tail-example.ts.net');

  test('config() translates SocketException into actionable copy', () async {
    final api = Api(
      settings,
      client: MockClient((_) async => throw const SocketException('nope')),
    );

    await expectLater(
      api.config(),
      throwsA(
        isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains("Can't reach the bridge"),
        ),
      ),
    );
  });

  test('config() translates a TLS failure into actionable copy', () async {
    final api = Api(
      settings,
      client: MockClient(
        (_) async => throw const HandshakeException('bad cert'),
      ),
    );

    await expectLater(
      api.config(),
      throwsA(
        isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('secure connection'),
        ),
      ),
    );
  });

  test(
    'sessions() translates http.ClientException into actionable copy',
    () async {
      final api = Api(
        settings,
        client: MockClient(
          (_) async => throw http.ClientException('connection closed'),
        ),
      );

      await expectLater(
        api.sessions(),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains("Can't reach the bridge"),
          ),
        ),
      );
    },
  );

  test('a malformed bridge URL raises a friendly message', () async {
    final api = Api(
      AppSettings(baseUrl: 'https://host:notaport'),
      client: MockClient((_) async => http.Response('{}', 200)),
    );

    await expectLater(
      api.config(),
      throwsA(
        isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains("doesn't look like a valid"),
        ),
      ),
    );
  });

  test('config() still surfaces HTTP-status failures unchanged', () async {
    final api = Api(
      settings,
      client: MockClient((_) async => http.Response('', 401)),
    );

    await expectLater(
      api.config(),
      throwsA(
        isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('Token required/invalid'),
        ),
      ),
    );
  });

  test('config() succeeds on a normal 200 response', () async {
    final api = Api(
      settings,
      client: MockClient(
        (_) async => http.Response('{"ok":true}', 200),
      ),
    );

    final result = await api.config();
    expect(result['ok'], isTrue);
  });
}
