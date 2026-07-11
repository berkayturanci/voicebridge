import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../qr_pairing.dart';
import '../theme.dart';

/// Scans the bridge's startup QR (see `server.js printPhoneQr`) and pops with
/// the parsed [ScannedPairing], or `null` if the user backs out.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _handled = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      final pairing = parsePairingQr(raw);
      if (pairing == null) {
        setState(
          () =>
              _error = "That QR code doesn't look like a bridge pairing code.",
        );
        continue;
      }
      _handled = true;
      Navigator.pop(context, pairing);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan bridge QR code')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          const _Frame(),
          Positioned(
            left: 0,
            right: 0,
            bottom: 32,
            child: Column(
              children: [
                const Text(
                  'Point the camera at the QR code printed when you run\n'
                  'npm start on your computer.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white, height: 1.4),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: VbColors.danger),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A simple viewfinder square so the user knows where to aim.
class _Frame extends StatelessWidget {
  const _Frame();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 240,
        height: 240,
        decoration: BoxDecoration(
          border: Border.all(color: Colors.white, width: 2),
          borderRadius: BorderRadius.circular(16),
        ),
      ),
    );
  }
}
