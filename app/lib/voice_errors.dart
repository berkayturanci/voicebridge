String ttsFailureMessage(Object? error) {
  final message = _message(error);

  if (_hasAny(message, ['voice', 'language', 'locale', 'engine'])) {
    return "Couldn't speak the reply. Install or select an English TTS voice, then try again.";
  }
  if (_hasAny(message, ['audio', 'route', 'volume', 'silent', 'speaker', 'playback'])) {
    return "Couldn't speak the reply. Check volume, silent mode, and the current audio output.";
  }
  if (_hasAny(message, ['permission', 'denied', 'notallowed'])) {
    return "Couldn't speak the reply. The app does not have permission to use audio output.";
  }

  return "Couldn't speak the reply. Check the selected voice, volume, and audio output.";
}

String sttFailureMessage(Object? error) {
  final message = _message(error);

  if (_hasAny(message, ['permission', 'denied', 'notallowed', 'microphone', 'record_audio'])) {
    return "Couldn't start listening. Check microphone and Speech Recognition permissions.";
  }
  if (_hasAny(message, ['speech', 'recognition', 'recognizer', 'language', 'locale'])) {
    return "Couldn't start listening. Speech Recognition is unavailable for this language or device.";
  }
  if (_hasAny(message, ['network', 'offline', 'timeout'])) {
    return "Couldn't start listening. Speech Recognition needs a network connection right now.";
  }
  if (_hasAny(message, ['audio', 'route', 'input', 'busy'])) {
    return "Couldn't start listening. Check the microphone input and audio route.";
  }

  return "Couldn't start listening. Check microphone permission and Speech Recognition availability.";
}

String get sttUnavailableMessage =>
    "Couldn't start listening. Check microphone permission and Speech Recognition availability.";

String _message(Object? error) => error?.toString().toLowerCase() ?? '';

bool _hasAny(String message, List<String> needles) =>
    needles.any((needle) => message.contains(needle));
