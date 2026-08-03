#pragma once

#include <QRectF>

#include "common/params.h"
#include "selfdrive/ui/qt/widgets/cameraview.h"

class BlindSpotCameraWidget : public CameraWidget {
  Q_OBJECT

public:
  explicit BlindSpotCameraWidget(QWidget *parent = nullptr);

  void setSide(bool left);

protected:
  mat4 calcFrameMatrix() override;
  void hideEvent(QHideEvent *event) override;
  void paintGL() override;

private:
  void loadZones();

  bool showLeft = true;

  QRectF leftZone = QRectF(0.6779, 0.3022, 0.2251, 0.2955);
  QRectF rightZone = QRectF(0.0731, 0.3079, 0.2293, 0.3105);

  Params params;
};
