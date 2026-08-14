import 'package:flutter_test/flutter_test.dart';
import 'package:voicebridge_app/qr_pairing.dart';

void main() {
  group('parsePairingQr', () {
    test('parses bridge URL with token', () {
      final result = parsePairingQr('https://mac.tailnet.ts.net/?token=abc123');

      expect(result, isNotNull);
      expect(result!.baseUrl, 'https://mac.tailnet.ts.net');
      expect(result.token, 'abc123');
    });

    test('parses bridge URL without token', () {
      final result = parsePairingQr('https://mac.tailnet.ts.net/');

      expect(result, isNotNull);
      expect(result!.baseUrl, 'https://mac.tailnet.ts.net');
      expect(result.token, '');
    });

    test('keeps path and port in the base URL', () {
      final result = parsePairingQr('http://127.0.0.1:8787/app?token=t');

      expect(result, isNotNull);
      expect(result!.baseUrl, 'http://127.0.0.1:8787/app');
      expect(result.token, 't');
    });

    test('returns null for unrelated QR content', () {
      expect(parsePairingQr('not a url'), isNull);
    });

    test('returns null for non-http URLs', () {
      expect(parsePairingQr('mailto:test@example.com'), isNull);
    });
  });

  group('parsePairingCode', () {
    test('parses JSON pairing payload', () {
      final result = parsePairingCode('''
        {
          "schema": "voicebridge.pairing",
          "version": 1,
          "bridgeUrl": "https://mac.tailnet.ts.net/?token=url-token",
          "token": "payload-token"
        }
      ''');

      expect(result.baseUrl, 'https://mac.tailnet.ts.net');
      expect(result.token, 'url-token');
    });

    test('uses payload token when URL has no token', () {
      final result = parsePairingCode('''
        {
          "schema": "voicebridge.pairing",
          "version": 1,
          "bridgeUrl": "https://mac.tailnet.ts.net",
          "token": "payload-token"
        }
      ''');

      expect(result.baseUrl, 'https://mac.tailnet.ts.net');
      expect(result.token, 'payload-token');
    });

    test('rejects unsupported payload schema', () {
      expect(
        () => parsePairingCode('{"schema":"other","bridgeUrl":"https://x"}'),
        throwsFormatException,
      );
    });

    test('rejects unsupported payload version', () {
      expect(
        () => parsePairingCode(
          '{"schema":"voicebridge.pairing","version":2,"bridgeUrl":"https://x"}',
        ),
        throwsFormatException,
      );
    });
  });
}
