import 'package:flutter_test/flutter_test.dart';
import 'package:voicebridge_app/qr_pairing.dart';

void main() {
  test('parses a URL with a token query param', () {
    final result = parsePairingQr(
      'https://mac.tail-abc123.ts.net?token=sekrit',
    );
    expect(result, isNotNull);
    expect(result!.baseUrl, 'https://mac.tail-abc123.ts.net');
    expect(result.token, 'sekrit');
  });

  test('parses a URL with no token as an empty token', () {
    final result = parsePairingQr('https://mac.tail-abc123.ts.net');
    expect(result, isNotNull);
    expect(result!.baseUrl, 'https://mac.tail-abc123.ts.net');
    expect(result.token, '');
  });

  test('parses a plain http fallback URL (host:port, no Tailscale)', () {
    final result = parsePairingQr('http://127.0.0.1:8787?token=abc');
    expect(result, isNotNull);
    expect(result!.baseUrl, 'http://127.0.0.1:8787');
    expect(result.token, 'abc');
  });

  test('trims surrounding whitespace from the scanned value', () {
    final result = parsePairingQr('  https://mac.tail-abc123.ts.net  ');
    expect(result, isNotNull);
    expect(result!.baseUrl, 'https://mac.tail-abc123.ts.net');
  });

  test('rejects a non-http(s) scheme', () {
    expect(parsePairingQr('mailto:someone@example.com'), isNull);
  });

  test('rejects an unrelated QR payload (not a URL at all)', () {
    expect(parsePairingQr('just some random scanned text'), isNull);
  });

  test('rejects an empty string', () {
    expect(parsePairingQr(''), isNull);
  });

  test('URL-decodes a percent-encoded token', () {
    final result = parsePairingQr(
      'https://mac.tail-abc123.ts.net?token=a%2Bb%3Dc',
    );
    expect(result!.token, 'a+b=c');
  });
}
