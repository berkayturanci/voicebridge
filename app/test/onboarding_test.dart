import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:voicebridge_app/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('first launch starts on the PC connection screen', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pumpAndSettle();

    expect(find.text('Connect to your PC'), findsOneWidget);
    expect(find.text('PC bridge URL'), findsOneWidget);
    expect(
      find.text('tailscale serve --bg --https=443 localhost:8787'),
      findsOneWidget,
    );

    await tester.scrollUntilVisible(
      find.text('Connect to PC'),
      80,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Connect to PC'), findsOneWidget);
  });
}
