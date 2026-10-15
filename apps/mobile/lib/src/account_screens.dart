import 'package:flutter/material.dart';

import 'account_auth.dart';
import 'account_models.dart';
import 'preferences.dart';
import 'preferences_screen.dart';
import 'theme.dart';

class AccountScreen extends StatelessWidget {
  const AccountScreen({
    super.key,
    required this.auth,
    required this.preferences,
    required this.onOpenOnboarding,
  });

  final AccountAuthController auth;
  final PreferencesRepository preferences;
  final VoidCallback onOpenOnboarding;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: IconButton(
        tooltip: 'Kembali',
        icon: const Icon(Icons.arrow_back),
        onPressed: () => Navigator.of(context).maybePop(),
      ),
      title: const Text('Akun'),
    ),
    body: SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: AnimatedBuilder(
            animation: auth,
            builder: (context, _) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Baca informasi publik tanpa akun.',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Google login bersifat pilihan. Layanan menyimpan identitas Google terverifikasi, nama, email, peran yang ditetapkan layanan, serta versi dan waktu penyelesaian panduan.',
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 20),
                  _accountState(context),
                  if (auth.message != null) ...[
                    const SizedBox(height: 12),
                    _StatusMessage(message: auth.message!),
                  ],
                  const SizedBox(height: 20),
                  OutlinedButton.icon(
                    onPressed: auth.isBusy ? null : onOpenOnboarding,
                    icon: const Icon(Icons.menu_book_outlined),
                    label: const Text('Baca panduan awal'),
                  ),
                  const SizedBox(height: 8),
                  if (auth.status == AccountAuthStatus.offline ||
                      auth.status == AccountAuthStatus.error ||
                      auth.status == AccountAuthStatus.unavailable)
                    TextButton.icon(
                      onPressed: auth.isBusy ? null : auth.retry,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Periksa status akun lagi'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );

  Widget _accountState(BuildContext context) {
    if (auth.status == AccountAuthStatus.restoring) {
      return const _StatusCard(
        icon: Icons.sync,
        title: 'Memeriksa sesi akun',
        message: 'Bacaan publik tetap dapat digunakan selama pemeriksaan.',
        progress: true,
      );
    }
    if (auth.isAuthenticated) {
      final user = auth.user!;
      return _StatusCard(
        icon: Icons.account_circle_outlined,
        title: user.displayName,
        message:
            '${user.email}\nPeran: ${accountRoleLabel(user.role)}\n'
            '${user.onboardingComplete ? 'Panduan awal selesai.' : 'Panduan awal belum selesai.'}',
        footer: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!user.onboardingComplete) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: auth.isBusy ? null : onOpenOnboarding,
                icon: const Icon(Icons.arrow_forward),
                label: const Text('Lanjutkan panduan awal'),
              ),
            ],
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: auth.isBusy ? null : auth.logout,
              icon: const Icon(Icons.logout),
              label: Text(
                auth.action == AccountAuthAction.loggingOut
                    ? 'Keluar…'
                    : 'Keluar dari akun',
              ),
            ),
          ],
        ),
        progress: auth.isBusy,
      );
    }
    final title = switch (auth.status) {
      AccountAuthStatus.expired => 'Sesi akun berakhir',
      AccountAuthStatus.offline => 'Layanan akun sedang offline',
      AccountAuthStatus.unavailable => 'Login akun belum tersedia',
      AccountAuthStatus.error => 'Status akun belum dapat dibaca',
      _ => 'Belum masuk',
    };
    final message = switch (auth.status) {
      AccountAuthStatus.expired =>
        'Masuk kembali untuk memeriksa akun. Kamu tetap dapat membaca tanpa masuk.',
      AccountAuthStatus.offline =>
        'Status sesi belum dapat dipastikan. Minat lokal dan bacaan publik tetap tersedia.',
      AccountAuthStatus.unavailable => auth.loginUnavailableMessage,
      AccountAuthStatus.error =>
        'Pemeriksaan akun gagal. Bacaan publik tetap dapat digunakan.',
      _ =>
        'Akun tidak diperlukan untuk membaca laporan, bukti, dan riwayat publik.',
    };
    return _StatusCard(
      icon: auth.status == AccountAuthStatus.offline
          ? Icons.cloud_off_outlined
          : Icons.person_outline,
      title: title,
      message: message,
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (auth.googleLoginAvailable) ...[
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: auth.isBusy ? null : auth.signInWithGoogle,
              icon: const Icon(Icons.login),
              label: Text(
                auth.action == AccountAuthAction.signingIn
                    ? 'Menghubungkan akun…'
                    : 'Masuk dengan Google',
              ),
            ),
          ] else if (auth.status == AccountAuthStatus.anonymous ||
              auth.status == AccountAuthStatus.expired) ...[
            const SizedBox(height: 12),
            Text(
              auth.loginUnavailableMessage,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
      progress: auth.action == AccountAuthAction.signingIn,
    );
  }
}

class AccountOnboardingScreen extends StatefulWidget {
  const AccountOnboardingScreen({
    super.key,
    required this.auth,
    required this.preferences,
  });

  final AccountAuthController auth;
  final PreferencesRepository preferences;

  @override
  State<AccountOnboardingScreen> createState() =>
      _AccountOnboardingScreenState();
}

class _AccountOnboardingScreenState extends State<AccountOnboardingScreen> {
  int _step = 0;

  Future<void> _openLocalInterests() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => PreferencesScreen(repository: widget.preferences),
      ),
    );
  }

  Future<void> _finish() async {
    final user = widget.auth.user;
    if (user != null && !user.onboardingComplete) {
      final saved = await widget.auth.completeOnboarding();
      if (!mounted) return;
      if (!saved) return;
    }
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: IconButton(
        tooltip: 'Kembali',
        icon: const Icon(Icons.arrow_back),
        onPressed: () => Navigator.of(context).maybePop(),
      ),
      title: const Text('Panduan awal'),
    ),
    body: SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: AnimatedBuilder(
            animation: widget.auth,
            builder: (context, _) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      'Langkah ${_step + 1} dari 3',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                  ),
                  const SizedBox(height: 8),
                  LinearProgressIndicator(value: (_step + 1) / 3),
                  const SizedBox(height: 24),
                  ..._stepContent(context),
                  if (widget.auth.message != null &&
                      widget.auth.action ==
                          AccountAuthAction.completingOnboarding) ...[
                    const SizedBox(height: 14),
                    const LinearProgressIndicator(),
                  ] else if (widget.auth.message != null) ...[
                    const SizedBox(height: 14),
                    _StatusMessage(message: widget.auth.message!),
                  ],
                  if (widget.auth.status == AccountAuthStatus.offline ||
                      widget.auth.status == AccountAuthStatus.error ||
                      widget.auth.status == AccountAuthStatus.unavailable)
                    TextButton.icon(
                      onPressed: widget.auth.isBusy ? null : widget.auth.retry,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Periksa status akun lagi'),
                    ),
                  const SizedBox(height: 28),
                  if (_step < 2)
                    FilledButton.icon(
                      onPressed: () => setState(() => _step++),
                      icon: const Icon(Icons.arrow_forward),
                      label: const Text('Lanjut'),
                    )
                  else
                    FilledButton.icon(
                      onPressed: widget.auth.isBusy ? null : _finish,
                      icon: const Icon(Icons.check),
                      label: Text(
                        widget.auth.isBusy
                            ? 'Menyimpan…'
                            : 'Selesaikan panduan',
                      ),
                    ),
                  TextButton(
                    onPressed: widget.auth.isBusy
                        ? null
                        : () => Navigator.of(context).maybePop(),
                    child: const Text('Lewati panduan'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );

  List<Widget> _stepContent(BuildContext context) => switch (_step) {
    0 => [
      const Icon(
        Icons.fact_check_outlined,
        size: 42,
        color: WaspadaColors.teal,
      ),
      const SizedBox(height: 14),
      Text(
        'Baca status dengan konteks',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 10),
      Text(
        'Status kejadian menjelaskan tahap kejadian. Kesegaran menjelaskan kapan bukti terakhir dinilai. Minat membantu menandai laporan yang mungkin relevan untukmu. Ketiganya tidak membuktikan kondisi fisik aman atau bahwa kejadian sudah selesai.',
        style: Theme.of(context).textTheme.bodyLarge,
      ),
      const SizedBox(height: 14),
      const _StatusCard(
        icon: Icons.info_outline,
        title: 'Kosong bukan berarti aman',
        message:
            'Laporan yang tidak muncul dapat berarti informasi belum tersedia atau belum cocok dengan pilihanmu.',
      ),
    ],
    1 => [
      const Icon(Icons.tune, size: 42, color: WaspadaColors.teal),
      const SizedBox(height: 14),
      Text(
        'Minat bersifat pilihan',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 10),
      Text(
        'Kamu boleh memilih kategori, tempat, layanan, lembaga, atau kelompok. Pilihan itu disimpan dan dicocokkan hanya di perangkat ini. Minat tidak diunggah, dan aplikasi tidak meminta lokasi.',
        style: Theme.of(context).textTheme.bodyLarge,
      ),
      const SizedBox(height: 18),
      OutlinedButton.icon(
        onPressed: _openLocalInterests,
        icon: const Icon(Icons.tune),
        label: const Text('Atur minat di perangkat ini'),
      ),
    ],
    _ => [
      const Icon(
        Icons.privacy_tip_outlined,
        size: 42,
        color: WaspadaColors.teal,
      ),
      const SizedBox(height: 14),
      Text(
        'Privasi dan akun',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 10),
      Text(
        'Bacaan publik tidak memerlukan login. Jika memilih Google login, layanan memverifikasi dan menyimpan identitas Google, nama, email, peran yang ditetapkan layanan, serta versi dan waktu penyelesaian panduan. Android hanya menyimpan token sesi dari layanan di penyimpanan aman perangkat. Minat tetap disimpan di perangkat ini dan tidak diunggah. Aplikasi tidak meminta lokasi. Keluar dari akun menghapus token sesi, tetapi tidak menghapus minat lokal.',
        style: Theme.of(context).textTheme.bodyLarge,
      ),
      const SizedBox(height: 14),
      const _StatusCard(
        icon: Icons.lock_outline,
        title: 'Kamu tetap memegang pilihan',
        message:
            'Login, pengaturan minat lokal, dan penyelesaian panduan dapat dilewati. Peran akun hanya ditampilkan oleh layanan.',
      ),
    ],
  };
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.icon,
    required this.title,
    required this.message,
    this.footer,
    this.progress = false,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? footer;
  final bool progress;

  @override
  Widget build(BuildContext context) => Card(
    color: WaspadaColors.white,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: WaspadaColors.teal),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 6),
                    Text(message),
                  ],
                ),
              ),
            ],
          ),
          if (progress) ...[
            const SizedBox(height: 14),
            const LinearProgressIndicator(),
          ],
          if (footer != null) footer!,
        ],
      ),
    ),
  );
}

class _StatusMessage extends StatelessWidget {
  const _StatusMessage({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: WaspadaColors.softPanel,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(message),
    ),
  );
}
