#include "frogpilot/ui/qt/onroad/blind_spot_camera.h"

#include <algorithm>

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPainter>

BlindSpotCameraWidget::BlindSpotCameraWidget(QWidget *parent) : CameraWidget("camerad", VISION_STREAM_DRIVER, parent) {
  loadZones();
}

void BlindSpotCameraWidget::loadZones() {
  QJsonObject zones = QJsonDocument::fromJson(QByteArray::fromStdString(params.get("VisionBSMZones"))).object();

  for (const QString &side : {QStringLiteral("left"), QStringLiteral("right")}) {
    double x0 = 1.0, y0 = 1.0, x1 = 0.0, y1 = 0.0;
    for (const QJsonValue &polygon : zones.value(side).toArray()) {
      for (const QJsonValue &point : polygon.toArray()) {
        QJsonArray xy = point.toArray();
        if (xy.size() != 2) {
          continue;
        }
        x0 = std::min(x0, xy[0].toDouble());
        x1 = std::max(x1, xy[0].toDouble());
        y0 = std::min(y0, xy[1].toDouble());
        y1 = std::max(y1, xy[1].toDouble());
      }
    }

    if (x1 > x0 && y1 > y0) {
      (side == QStringLiteral("left") ? leftZone : rightZone) = QRectF(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

void BlindSpotCameraWidget::setSide(bool left) {
  showLeft = left;
}

mat4 BlindSpotCameraWidget::calcFrameMatrix() {
  const QRectF zone = showLeft ? leftZone : rightZone;
  if (stream_width == 0 || stream_height == 0 || zone.width() <= 0 || zone.height() <= 0) {
    return CameraWidget::calcFrameMatrix();
  }

  // the quad spans the whole frame, so magnify it until only the zone is left on screen
  float sx = 2.0f / zone.width();
  float sy = 2.0f / zone.height();

  // without this the crop gets stretched to whatever shape the panel happens to be
  float zoneRatio = (zone.width() * stream_width) / (zone.height() * stream_height);
  float widgetRatio = (float)width() / height();
  if (zoneRatio < widgetRatio) {
    sx *= zoneRatio / widgetRatio;
  } else {
    sy *= widgetRatio / zoneRatio;
  }

  // the driver stream is mirrored horizontally and its texture runs bottom up
  float xCenter = 1.0f - (zone.left() + zone.right());
  float yCenter = 1.0f - (zone.top() + zone.bottom());

  return mat4{{
     sx, 0.0, 0.0, -sx * xCenter,
    0.0,  sy, 0.0, -sy * yCenter,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
  }};
}

void BlindSpotCameraWidget::hideEvent(QHideEvent *event) {
  stopVipcThread();
  CameraWidget::hideEvent(event);
}

void BlindSpotCameraWidget::paintGL() {
  CameraWidget::paintGL();

  QPainter p(this);
  p.setRenderHint(QPainter::Antialiasing);
  p.setBrush(Qt::NoBrush);
  p.setPen(QPen(QColor(0xda, 0x6f, 0x25, 0xf1), 6));
  p.drawRoundedRect(rect().adjusted(3, 3, -3, -3), 12, 12);
}
