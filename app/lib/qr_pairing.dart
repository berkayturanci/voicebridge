/// Parsed result of scanning the bridge's startup QR.
///
/// The bridge (see `server.js`'s `phoneUrl`/`printPhoneQr`) encodes a plain
/// URL with an optional `?token=` query param — the same convention the web
/// PWA already reads on load (`public/index.html`). No custom payload format,
/// just a URL.
class ScannedPairing {
  final String baseUrl;
  final String token;
  const ScannedPairing({required this.baseUrl, required this.token});
}

/// Returns null if [raw] isn't a URL the bridge would have produced (e.g. an
/// unrelated QR code was scanned).
ScannedPairing? parsePairingQr(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null || !uri.hasAuthority) return null;
  if (uri.scheme != 'http' && uri.scheme != 'https') return null;

  final token = uri.queryParameters['token'] ?? '';
  final base = Uri(
    scheme: uri.scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
    path: uri.path,
  ).toString();

  return ScannedPairing(baseUrl: base, token: token);
}
