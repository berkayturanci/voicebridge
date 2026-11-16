import 'package:flutter_test/flutter_test.dart';
import 'package:voicebridge_app/api.dart';

void main() {
  test('no spoken events → not from server, nothing to say', () {
    final s = SpokenReply();
    expect(s.onEvent({'type': 'delta', 'text': 'hello'}), isNull);
    expect(s.fromServer, isFalse);
    expect(s.text, isEmpty);
  });

  test('speech events accumulate as the reply to read', () {
    final s = SpokenReply();
    expect(s.onEvent({'type': 'speech', 'text': 'Done.'}), isNull);
    expect(s.onEvent({'type': 'speech', 'text': ' All  green. '}), isNull);
    expect(s.fromServer, isTrue);
    expect(s.text, 'Done. All green.');
  });

  test('final narration is part of the reply; progress/approval/background are immediate', () {
    final s = SpokenReply();
    expect(s.onEvent({'type': 'narration', 'kind': 'progress', 'text': 'Running the tests.'}), 'Running the tests.');
    expect(s.onEvent({'type': 'narration', 'kind': 'approval', 'text': 'api is waiting for your approval.'}), 'api is waiting for your approval.');
    expect(s.onEvent({'type': 'narration', 'kind': 'background', 'text': 'web finished.'}), 'web finished.');
    expect(s.text, isEmpty);
    expect(s.onEvent({'type': 'narration', 'kind': 'final', 'text': 'Fixed it; tests pass.'}), isNull);
    expect(s.text, 'Fixed it; tests pass.');
    expect(s.fromServer, isTrue);
  });

  test('empty texts are ignored', () {
    final s = SpokenReply();
    expect(s.onEvent({'type': 'narration', 'kind': 'progress', 'text': '  '}), isNull);
    expect(s.onEvent({'type': 'speech'}), isNull);
    expect(s.fromServer, isFalse);
  });
}
