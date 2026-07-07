import 'package:flutter_test/flutter_test.dart';
import 'package:voicebridge_app/voice_errors.dart';

void main() {
  group('voice failure messages', () {
    test('maps TTS voice and locale failures to install/select guidance', () {
      expect(
        ttsFailureMessage('No voice for locale en-US'),
        contains('Install or select an English TTS voice'),
      );
    });

    test('maps TTS audio route failures to volume/output guidance', () {
      expect(
        ttsFailureMessage('audio route unavailable'),
        contains('Check volume, silent mode'),
      );
    });

    test('maps STT permission failures to microphone guidance', () {
      expect(
        sttFailureMessage('permission denied: microphone'),
        contains('microphone and Speech Recognition permissions'),
      );
    });

    test('maps STT availability failures to recognizer guidance', () {
      expect(
        sttFailureMessage('speech recognizer not available for locale'),
        contains('Speech Recognition is unavailable'),
      );
    });
  });
}
