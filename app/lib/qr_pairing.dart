import 'dart:convert';

class PairingDetails {
  final String baseUrl;
  final String token;

  const PairingDetails({required this.baseUrl, required this.token});
}

typedef ScannedPairing = PairingDetails;

PairingDetails parsePairingCode(String raw) {
  final text = raw.trim();
  if (text.isEmpty) throw const FormatException('Empty pairing code');

  if (text.startsWith('{')) {
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid pairing payload');
    }
    final schema = decoded['schema'];
    if (schema != null && schema != 'voicebridge.pairing') {
      throw const FormatException('Unsupported pairing payload');
    }
    final version = decoded['version'];
    if (version != null && version != 1) {
      throw const FormatException('Unsupported pairing version');
    }
    final bridgeUrl = (decoded['bridgeUrl'] ?? decoded['url'] ?? '').toString();
    final token = (decoded['token'] ?? '').toString();
    final details = _fromUrl(bridgeUrl, fallbackToken: token);
    if (details.baseUrl.isEmpty) {
      throw const FormatException('Pairing payload is missing bridgeUrl');
    }
    return details;
  }

  return _fromUrl(text);
}

ScannedPairing? parsePairingQr(String raw) {
  try {
    return parsePairingCode(raw);
  } catch (_) {
    return null;
  }
}

PairingDetails _fromUrl(String rawUrl, {String fallbackToken = ''}) {
  final url = rawUrl.trim();
  if (url.isEmpty) {
    return PairingDetails(baseUrl: '', token: fallbackToken.trim());
  }
  final uri = Uri.tryParse(url);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
    throw const FormatException('Pairing code is not a valid URL');
  }
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    throw const FormatException('Pairing code must be an HTTP URL');
  }
  final token = (uri.queryParameters['token'] ?? fallbackToken).trim();
  final filteredQuery = _withoutToken(uri.queryParameters);
  final clean = uri.hasPort
      ? Uri(
          scheme: uri.scheme,
          userInfo: uri.userInfo,
          host: uri.host,
          port: uri.port,
          path: uri.path,
          queryParameters: filteredQuery,
        )
      : Uri(
          scheme: uri.scheme,
          userInfo: uri.userInfo,
          host: uri.host,
          path: uri.path,
          queryParameters: filteredQuery,
        );
  return PairingDetails(
    baseUrl: _stripTrailingSlash(clean.toString()),
    token: token,
  );
}

Map<String, String>? _withoutToken(Map<String, String> params) {
  final next = Map<String, String>.from(params)..remove('token');
  return next.isEmpty ? null : next;
}

String _stripTrailingSlash(String value) {
  var out = value.trim();
  while (out.endsWith('/')) {
    out = out.substring(0, out.length - 1);
  }
  return out;
}
