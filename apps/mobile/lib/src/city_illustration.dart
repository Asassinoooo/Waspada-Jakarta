import 'package:flutter/material.dart';

import 'theme.dart';

class CityIllustration extends StatefulWidget {
  const CityIllustration({super.key});
  @override
  State<CityIllustration> createState() => _CityIllustrationState();
}

class _CityIllustrationState extends State<CityIllustration>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 950), value: 1);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduced = MediaQuery.disableAnimationsOf(context);
    if (!_started) {
      _started = true;
      if (reduced) {
        _controller.value = 1;
      } else {
        _controller.value = 0;
        _controller.forward();
      }
    } else if (reduced && !_controller.isCompleted) {
      _controller.stop();
      _controller.value = 1;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
        child: SizedBox(
          height: 190,
          width: double.infinity,
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, child) => Transform.translate(
              offset: Offset(0, (1 - _controller.value) * 8),
              child: CustomPaint(
                  painter: _JakartaPainter(_controller.value), child: child),
            ),
            child: const SizedBox.expand(),
          ),
        ),
      );
}

class _JakartaPainter extends CustomPainter {
  const _JakartaPainter(this.progress);
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = Offset.zero & size;
    final panel = RRect.fromRectAndRadius(bounds, const Radius.circular(14));
    canvas.drawRRect(panel, Paint()..color = WaspadaColors.ink);
    final width = size.width;
    final height = size.height;
    final baseline = height * 0.78;

    final planePaint = Paint()..color = const Color(0xFF365158);
    canvas.drawRect(
        Rect.fromLTWH(0, baseline - 22, width, height * 0.24), planePaint);

    // Original skyline and Monas illustration. Shapes are decorative and carry no incident data.
    final buildingPaint = Paint()..color = const Color(0xFFADC0BB);
    final buildings = <Rect>[
      Rect.fromLTWH(width * .04, baseline - 49, width * .12, 49),
      Rect.fromLTWH(width * .18, baseline - 70, width * .105, 70),
      Rect.fromLTWH(width * .31, baseline - 44, width * .12, 44),
      Rect.fromLTWH(width * .68, baseline - 58, width * .12, 58),
      Rect.fromLTWH(width * .83, baseline - 76, width * .1, 76),
      Rect.fromLTWH(width * .95, baseline - 47, width * .1, 47),
    ];
    for (final rect in buildings) {
      canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(3)),
          buildingPaint);
      for (var row = 0; row < 3; row++) {
        canvas.drawLine(
            Offset(rect.left + 5, rect.top + 12 + row * 10),
            Offset(rect.right - 5, rect.top + 12 + row * 10),
            Paint()
              ..color = WaspadaColors.ink.withValues(alpha: .45)
              ..strokeWidth = 2);
      }
    }

    final center = width * .51;
    final monumentPaint = Paint()..color = WaspadaColors.white;
    final monument = Path()
      ..moveTo(center - 15, baseline - 1)
      ..lineTo(center - 11, baseline - 88)
      ..lineTo(center + 11, baseline - 88)
      ..lineTo(center + 15, baseline - 1)
      ..close();
    canvas.drawPath(monument, monumentPaint);
    canvas.drawRect(Rect.fromLTWH(center - 13, baseline - 88, 26, 4),
        Paint()..color = WaspadaColors.caution);
    final flame = Path()
      ..moveTo(center, baseline - 105)
      ..cubicTo(center - 11, baseline - 99, center - 5, baseline - 92, center,
          baseline - 89)
      ..cubicTo(center + 5, baseline - 92, center + 11, baseline - 99, center,
          baseline - 105)
      ..close();
    canvas.drawPath(flame, Paint()..color = WaspadaColors.caution);
    canvas.drawRect(Rect.fromLTWH(center - 26, baseline - 1, 52, 5),
        Paint()..color = WaspadaColors.white);

    final flyover = Path()
      ..moveTo(width * .03, baseline - 8)
      ..cubicTo(width * .22, baseline - 103, width * .4, baseline - 58,
          width * .63, baseline - 39)
      ..cubicTo(width * .78, baseline - 28, width * .91, baseline - 34,
          width * 1.03, baseline - 24);
    canvas.drawPath(
        flyover,
        Paint()
          ..color = const Color(0xFFCAD6D2)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 8
          ..strokeCap = StrokeCap.round);
    canvas.drawPath(
        flyover,
        Paint()
          ..color = WaspadaColors.ink
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5);

    final river = Path()
      ..moveTo(-5, height * .89)
      ..cubicTo(width * .14, height * .72, width * .24, height * .97,
          width * .39, height * .84)
      ..cubicTo(width * .55, height * .7, width * .62, height * .92,
          width * .77, height * .82)
      ..cubicTo(width * .87, height * .75, width * .94, height * .78, width + 8,
          height * .72);
    final metrics = river.computeMetrics().toList();
    if (metrics.isNotEmpty) {
      final revealed = metrics.first
          .extractPath(0, metrics.first.length * progress.clamp(0, 1));
      canvas.drawPath(
          revealed,
          Paint()
            ..color = WaspadaColors.teal
            ..style = PaintingStyle.stroke
            ..strokeWidth = 11
            ..strokeCap = StrokeCap.round);
    }

    final sunPaint = Paint()..color = WaspadaColors.caution;
    canvas.drawCircle(Offset(width * .88, height * .23), 9, sunPaint);
    final border = Paint()
      ..color = WaspadaColors.white.withValues(alpha: .18)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawRRect(panel, border);
  }

  @override
  bool shouldRepaint(covariant _JakartaPainter oldDelegate) =>
      oldDelegate.progress != progress;
}
