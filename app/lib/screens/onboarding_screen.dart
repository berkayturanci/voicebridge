import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../settings.dart';
import '../theme.dart';
import 'settings_screen.dart';

/// A short, skippable explainer shown once before the connect screen, for a
/// stranger who downloaded the app from an app store with zero context on
/// what VoiceBridge is or what it needs from them.
class OnboardingScreen extends StatefulWidget {
  final AppSettings settings;
  const OnboardingScreen({super.key, required this.settings});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pages = PageController();
  int _page = 0;
  static const _pageCount = 3;

  static final Uri _docsUrl = Uri.parse(
    'https://github.com/berkayturanci/voicebridge#readme',
  );

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  Future<void> _finish() async {
    await widget.settings.markOnboardingSeen();
    if (!mounted) return;
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(
        builder: (_) => SettingsScreen(settings: widget.settings),
      ),
    );
  }

  void _next() {
    if (_page == _pageCount - 1) {
      _finish();
      return;
    }
    _pages.nextPage(
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.topRight,
              child: TextButton(
                onPressed: _finish,
                child: Text(
                  'Skip',
                  style: TextStyle(color: VbColors.textMuted),
                ),
              ),
            ),
            Expanded(
              child: PageView(
                controller: _pages,
                onPageChanged: (i) => setState(() => _page = i),
                children: [
                  _WhatItIsPage(),
                  _WhatYouNeedPage(
                      onLearnMore: () => launchUrl(
                            _docsUrl,
                            mode: LaunchMode.externalApplication,
                          )),
                  const _YoureInControlPage(),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(
                      _pageCount,
                      (i) => Container(
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        width: i == _page ? 20 : 6,
                        height: 6,
                        decoration: BoxDecoration(
                          color: i == _page ? VbColors.accent : VbColors.border,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  FilledButton(
                    onPressed: _next,
                    child: Text(
                      _page == _pageCount - 1 ? "Let's connect" : 'Next',
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Widget _iconBadge(IconData icon) => Container(
      width: 84,
      height: 84,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [VbColors.accentBright, VbColors.accentDim],
        ),
      ),
      child: Icon(icon, color: const Color(0xFF06210C), size: 42),
    );

Widget _pageTitle(String text) => Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: 24,
        fontWeight: FontWeight.w800,
        color: VbColors.textPrimary,
      ),
    );

Widget _pageBody(String text) => Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 14.5, color: VbColors.textMuted, height: 1.5),
    );

class _WhatItIsPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 28),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _iconBadge(Icons.graphic_eq_rounded),
          const SizedBox(height: 26),
          _pageTitle('Talk to your coding agent'),
          const SizedBox(height: 12),
          _pageBody(
            'VoiceBridge lets you talk or type to Claude Code, Codex, '
            'Antigravity, or Ollama from your phone — hands-free, while '
            "you're away from your desk.",
          ),
        ],
      ),
    );
  }
}

class _WhatYouNeedPage extends StatelessWidget {
  final VoidCallback onLearnMore;
  const _WhatYouNeedPage({required this.onLearnMore});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 28),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _iconBadge(Icons.computer_rounded),
          const SizedBox(height: 26),
          _pageTitle('This app needs your own PC'),
          const SizedBox(height: 12),
          _pageBody(
            "VoiceBridge doesn't run in the cloud — it's a remote control "
            'for a small bridge you run yourself.',
          ),
          const SizedBox(height: 20),
          const _Checklist(
            items: [
              'A Mac or Linux computer you can leave running',
              'A coding agent (Claude Code, Codex, Antigravity, or '
                  'Ollama) already installed and signed in there',
              "Tailscale set up on both this phone and your computer",
            ],
          ),
          const SizedBox(height: 14),
          TextButton(
            onPressed: onLearnMore,
            child: const Text('See the full setup guide'),
          ),
        ],
      ),
    );
  }
}

class _Checklist extends StatelessWidget {
  final List<String> items;
  const _Checklist({required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.check_circle_outline_rounded,
                  size: 18,
                  color: VbColors.accent,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    item,
                    textAlign: TextAlign.left,
                    style: TextStyle(
                      fontSize: 13.5,
                      color: VbColors.textPrimary,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _YoureInControlPage extends StatelessWidget {
  const _YoureInControlPage();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 28),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _iconBadge(Icons.lock_outline_rounded),
          const SizedBox(height: 26),
          _pageTitle("You're always in control"),
          const SizedBox(height: 12),
          _pageBody(
            'Your bridge URL and access token stay on this device. Prompts '
            'and replies go straight to the computer you configure — never '
            'through a VoiceBridge-run server.',
          ),
        ],
      ),
    );
  }
}
