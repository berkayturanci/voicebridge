import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:voicebridge_app/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a genuinely fresh install sees the onboarding explainer first', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pumpAndSettle();

    expect(find.text('Talk to your coding agent'), findsOneWidget);
    expect(find.text('Skip'), findsOneWidget);
    // Not yet on the connect screen.
    expect(find.text('Connect to your PC'), findsNothing);
  });

  testWidgets('tapping through onboarding lands on the PC connection screen', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pumpAndSettle();

    // Page 1 -> 2 -> 3, then "Let's connect".
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('This app needs your own PC'), findsOneWidget);

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text("You're always in control"), findsOneWidget);

    await tester.tap(find.text("Let's connect"));
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

  testWidgets('Skip dismisses onboarding and lands on the connection screen', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();

    expect(find.text('Connect to your PC'), findsOneWidget);
  });

  testWidgets('onboarding does not reappear after it has been seen', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({'hasSeenOnboarding': true});

    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pumpAndSettle();

    expect(find.text('Talk to your coding agent'), findsNothing);
    expect(find.text('Connect to your PC'), findsOneWidget);
  });

  testWidgets(
    'an existing configured install (upgrading into this feature) skips onboarding',
    (WidgetTester tester) async {
      // hasSeenOnboarding absent (as on an upgrade from before this field
      // existed), but a bridge URL is already saved.
      SharedPreferences.setMockInitialValues({
        'baseUrl': 'https://mac.tail-abc123.ts.net',
      });

      await tester.pumpWidget(const VoiceBridgeApp());
      await tester.pumpAndSettle();

      expect(find.text('Talk to your coding agent'), findsNothing);
    },
  );
}
