import 'package:flutter/material.dart';

import 'preferences.dart';
import 'public_models.dart';
import 'read_guide_screen.dart';
import 'theme.dart';
import 'ui_helpers.dart';

class PreferencesScreen extends StatefulWidget {
  const PreferencesScreen({super.key, required this.repository});
  final PreferencesRepository repository;
  @override
  State<PreferencesScreen> createState() => _PreferencesScreenState();
}

class _PreferencesScreenState extends State<PreferencesScreen> {
  LocalInterests _interests = const LocalInterests();
  PreferenceLoadStatus? _loadStatus;
  PreferenceWriteStatus? _writeStatus;
  bool _loading = true;
  bool _saving = false;
  bool _clearing = false;
  bool _writing = false;
  bool _saved = true;
  String? _validationMessage;
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool retry = false}) async {
    if (_writing || retry && (!_saved || _loading)) {
      return;
    }
    final generation = ++_loadGeneration;
    if (retry && mounted) setState(() => _loading = true);
    final result = await widget.repository.load();
    if (!mounted || generation != _loadGeneration) return;
    setState(() {
      _interests = result.interests;
      _loadStatus = result.status;
      _loading = false;
      _saved = true;
    });
  }

  void _change(LocalInterests interests) {
    if (_writing) return;
    setState(() {
      _interests = interests;
      _saved = false;
      _writeStatus = null;
      _validationMessage = null;
    });
  }

  Future<void> _save() async {
    if (_writing) return;
    final snapshot = LocalInterests(
      places: _interests.places.toList(growable: false),
      services: _interests.services.toList(growable: false),
      institutions: _interests.institutions.toList(growable: false),
      audiences: _interests.audiences.toList(growable: false),
      categories: _interests.categories.toList(growable: false),
    );
    setState(() {
      _writing = true;
      _saving = true;
    });
    final result = await widget.repository.save(snapshot);
    if (!mounted) return;
    setState(() {
      _writeStatus = result;
      _writing = false;
      _saving = false;
      _saved = result == PreferenceWriteStatus.saved;
      if (result == PreferenceWriteStatus.saved) {
        _loadStatus = PreferenceLoadStatus.loaded;
      }
      if (result == PreferenceWriteStatus.invalid) {
        _validationMessage =
            'Ada pilihan yang tidak dapat disimpan. Periksa batas jumlah dan panjang teks.';
      }
    });
  }

  Future<void> _clear() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Hapus minat dari perangkat ini?'),
        content: const Text(
            'Tindakan ini menghapus minat yang disimpan aplikasi pada perangkat ini. Tidak ada data pada layanan yang dihapus.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Batal')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Hapus minat')),
        ],
      ),
    );
    if (confirmed != true || !mounted || _writing) return;
    setState(() {
      _writing = true;
      _clearing = true;
    });
    final cleared = await widget.repository.clear();
    if (!mounted) return;
    setState(() {
      _writing = false;
      _clearing = false;
      if (cleared) {
        _interests = const LocalInterests();
        _loadStatus = PreferenceLoadStatus.empty;
        _writeStatus = null;
        _validationMessage = null;
        _saved = true;
      }
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(cleared
            ? 'Minat lokal dihapus dari perangkat ini.'
            : 'Minat belum dapat dihapus. Coba lagi.')));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
            title: const Text('Minat dan privasi'),
            leading: IconButton(
                tooltip: 'Kembali',
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.arrow_back)),
            actions: [
              IconButton(
                  tooltip: 'Buka panduan membaca',
                  onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                          builder: (_) => const ReadGuideScreen())),
                  icon: const Icon(Icons.help_outline))
            ]),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                children: [
                    Semantics(
                      header: true,
                      child: Text('Pilih yang ingin kamu ikuti',
                          style: Theme.of(context).textTheme.headlineMedium),
                    ),
                    const SizedBox(height: 8),
                    Text(
                        'Pilihan ini opsional. Kamu tetap dapat membaca seluruh daftar tanpa menyimpan minat.',
                        style: Theme.of(context).textTheme.bodyLarge),
                    const SizedBox(height: 16),
                    const ReadOnlyNotice(
                        title: 'Tersimpan lokal tanpa pencadangan aplikasi.',
                        message:
                            'Mengubah atau menyimpan minat tidak mengirim nilai minat ke layanan. Aplikasi mencocokkan minat dengan kategori dan cakupan yang sedang tampil. Aplikasi tidak menyinkronkan atau mencadangkan pilihan ini ke perangkat lain.'),
                    if (_loadStatus == PreferenceLoadStatus.malformed) ...[
                      const SizedBox(height: 12),
                      const ReadOnlyNotice(
                          title: 'Pilihan tersimpan tidak dapat dibaca.',
                          message:
                              'Pilihan ini belum dapat dibaca. Simpan pilihan baru untuk mengganti pilihan tersimpan, atau hapus minat yang disimpan aplikasi ini.'),
                    ],
                    if (_loadStatus == PreferenceLoadStatus.unavailable) ...[
                      const SizedBox(height: 12),
                      const ReadOnlyNotice(
                          title: 'Penyimpanan perangkat tidak tersedia.',
                          message:
                              'Pilihan baru hanya berada di layar sampai penyimpanan dapat digunakan. Kamu tetap bisa menjelajah tanpa minat.'),
                      Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton.icon(
                              onPressed: _writing || _loading || !_saved
                                  ? null
                                  : () => _load(retry: true),
                              icon: const Icon(Icons.refresh),
                              label: const Text('Coba baca lagi'))),
                    ],
                    if (_loadStatus == PreferenceLoadStatus.loaded &&
                        _saved) ...[
                      const SizedBox(height: 10),
                      const Text('Pilihan dibaca dari perangkat ini.',
                          style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: WaspadaColors.teal)),
                    ],
                    if (!_saved) ...[
                      const SizedBox(height: 10),
                      const Text('Ada perubahan yang belum disimpan.',
                          style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: WaspadaColors.marker)),
                    ],
                    const SizedBox(height: 24),
                    sectionTitle('Kategori', kicker: 'Pencocokan lokal'),
                    const SizedBox(height: 8),
                    Text(
                        'Kategori yang dipilih menjadi petunjuk relevansi, bukan tingkat bahaya atau bukti.',
                        style: Theme.of(context).textTheme.bodyMedium),
                    const SizedBox(height: 10),
                    ...EventCategory.values.map((category) => CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _interests.categories.contains(category),
                          title: Text(category.label,
                              style: Theme.of(context).textTheme.bodyLarge),
                          controlAffinity: ListTileControlAffinity.leading,
                          onChanged: _writing
                              ? null
                              : (selected) {
                                  final categories = [..._interests.categories];
                                  if (selected == true &&
                                      !categories.contains(category)) {
                                    categories.add(category);
                                  }
                                  if (selected != true) {
                                    categories.remove(category);
                                  }
                                  _change(_interests.copyWith(
                                      categories: categories));
                                },
                        )),
                    const SizedBox(height: 18),
                    sectionTitle('Tempat, layanan, lembaga, atau kelompok',
                        kicker: 'Teks yang kamu pilih'),
                    const SizedBox(height: 8),
                    Text(
                        'Pilihan kelompok bisa sensitif. Hindari alamat rumah atau kerja yang sangat rinci. Teks akan dibandingkan dengan cakupan yang tersedia pada laporan.',
                        style: Theme.of(context).textTheme.bodyMedium),
                    const SizedBox(height: 12),
                    _TextInterestField(
                        label: 'Tempat',
                        values: _interests.places,
                        enabled: !_writing,
                        onChanged: (values) =>
                            _change(_interests.copyWith(places: values))),
                    _TextInterestField(
                        label: 'Layanan',
                        values: _interests.services,
                        enabled: !_writing,
                        onChanged: (values) =>
                            _change(_interests.copyWith(services: values))),
                    _TextInterestField(
                        label: 'Lembaga',
                        values: _interests.institutions,
                        enabled: !_writing,
                        onChanged: (values) =>
                            _change(_interests.copyWith(institutions: values))),
                    _TextInterestField(
                        label: 'Kelompok',
                        values: _interests.audiences,
                        enabled: !_writing,
                        onChanged: (values) =>
                            _change(_interests.copyWith(audiences: values))),
                    if (_validationMessage != null) ...[
                      const SizedBox(height: 8),
                      Text(_validationMessage!,
                          style: const TextStyle(
                              color: WaspadaColors.marker,
                              fontWeight: FontWeight.w600),
                          semanticsLabel: _validationMessage),
                    ],
                    if (_writeStatus == PreferenceWriteStatus.unavailable) ...[
                      const SizedBox(height: 8),
                      const ReadOnlyNotice(
                          title: 'Perubahan belum tersimpan.',
                          message:
                              'Minat saat ini hanya berada di memori layar. Coba simpan lagi; pembacaan umum tetap tersedia.'),
                    ],
                    const SizedBox(height: 14),
                    if (_saved && _writeStatus == PreferenceWriteStatus.saved)
                      const Text('Pilihan tersimpan di perangkat ini.',
                          style: TextStyle(
                              fontWeight: FontWeight.w700,
                              color: WaspadaColors.teal)),
                    Row(children: [
                      Expanded(
                          child: FilledButton.icon(
                              onPressed: _writing ? null : _save,
                              icon: _saving
                                  ? const SizedBox.square(
                                      dimension: 18,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2))
                                  : const Icon(Icons.save_outlined),
                              label: const Text('Simpan di perangkat'))),
                    ]),
                    const SizedBox(height: 5),
                    OutlinedButton.icon(
                        onPressed: _writing ? null : _clear,
                        icon: const Icon(Icons.delete_outline),
                        label: Text(_clearing
                            ? 'Menghapus…'
                            : 'Hapus minat tersimpan')),
                    const SizedBox(height: 8),
                    Text(
                        'Menghapus data aplikasi atau perangkat juga dapat menghapus pilihan ini. Kegagalan penyimpanan tidak menghalangi akses ke laporan publik.',
                        style: Theme.of(context).textTheme.bodyMedium),
                  ]),
      );
}

class _TextInterestField extends StatefulWidget {
  const _TextInterestField(
      {required this.label,
      required this.values,
      required this.enabled,
      required this.onChanged});
  final String label;
  final List<String> values;
  final bool enabled;
  final ValueChanged<List<String>> onChanged;
  @override
  State<_TextInterestField> createState() => _TextInterestFieldState();
}

class _TextInterestFieldState extends State<_TextInterestField> {
  final _controller = TextEditingController();
  String? _message;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _add() {
    final normalized = _controller.text.trim();
    if (normalized.isEmpty) {
      setState(() => _message = 'Tulis pilihan terlebih dahulu.');
      return;
    }
    if (normalized.runes.length > maxInterestCharacters) {
      setState(() =>
          _message = 'Gunakan paling banyak $maxInterestCharacters karakter.');
      return;
    }
    if (hasEquivalentLocalInterest(widget.values, normalized)) {
      setState(() => _message = 'Pilihan ini sudah ada.');
      return;
    }
    if (widget.values.length >= maxTextInterestsPerField) {
      setState(
          () => _message = 'Batas $maxTextInterestsPerField pilihan tercapai.');
      return;
    }
    widget.onChanged([...widget.values, normalized]);
    _controller.clear();
    setState(() => _message = null);
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.label, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
                child: TextField(
              controller: _controller,
              enabled: widget.enabled,
              maxLength: maxInterestCharacters,
              textInputAction: TextInputAction.done,
              onSubmitted: widget.enabled ? (_) => _add() : null,
              decoration: InputDecoration(
                  hintText: 'Tambahkan ${widget.label.toLowerCase()}',
                  counterText: ''),
              onChanged: (_) => setState(() => _message = null),
            )),
            const SizedBox(width: 8),
            Padding(
                padding: const EdgeInsets.only(top: 1),
                child: IconButton.filledTonal(
                    tooltip: 'Tambahkan ${widget.label.toLowerCase()}',
                    onPressed: widget.enabled ? _add : null,
                    icon: const Icon(Icons.add),
                    constraints:
                        const BoxConstraints(minWidth: 48, minHeight: 48))),
          ]),
          if (_message != null)
            Text(_message!,
                style: const TextStyle(color: WaspadaColors.marker),
                semanticsLabel: _message),
          if (widget.values.isNotEmpty)
            Wrap(
                spacing: 6,
                runSpacing: 2,
                children: widget.values
                    .map((value) => InputChip(
                          label: Text(value),
                          onDeleted: widget.enabled
                              ? () => widget.onChanged(widget.values
                                  .where((item) => item != value)
                                  .toList())
                              : null,
                        ))
                    .toList()),
        ]),
      );
}
