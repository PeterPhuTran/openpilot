#include "selfdrive/ui/qt/onroad/onroad_home.h"

#include <QPainter>
#include <QStackedLayout>

#include "selfdrive/ui/qt/util.h"

OnroadWindow::OnroadWindow(QWidget *parent) : QWidget(parent) {
  QVBoxLayout *main_layout  = new QVBoxLayout(this);
  main_layout->setMargin(UI_BORDER_SIZE);
  QStackedLayout *stacked_layout = new QStackedLayout;
  stacked_layout->setStackingMode(QStackedLayout::StackAll);
  main_layout->addLayout(stacked_layout);

  nvg = new AnnotatedCameraWidget(VISION_STREAM_ROAD, this);

  QWidget * split_wrapper = new QWidget;
  split = new QHBoxLayout(split_wrapper);
  split->setContentsMargins(0, 0, 0, 0);
  split->setSpacing(0);
  split->addWidget(nvg);

  if (getenv("DUAL_CAMERA_VIEW")) {
    CameraWidget *arCam = new CameraWidget("camerad", VISION_STREAM_ROAD, this);
    split->insertWidget(0, arCam);
  }

  stacked_layout->addWidget(split_wrapper);

  alerts = new OnroadAlerts(this);
  alerts->setAttribute(Qt::WA_TransparentForMouseEvents, true);
  stacked_layout->addWidget(alerts);

  // setup stacking order
  alerts->raise();

  setAttribute(Qt::WA_OpaquePaintEvent);
  QObject::connect(uiState(), &UIState::uiUpdate, this, &OnroadWindow::updateState);
  QObject::connect(uiState(), &UIState::offroadTransition, this, &OnroadWindow::offroadTransition);

  // FrogPilot variables
  blind_spot_camera = new BlindSpotCameraWidget(this);
  blind_spot_camera->setAttribute(Qt::WA_TransparentForMouseEvents, true);
  blind_spot_camera->setVisible(false);
  split->addWidget(blind_spot_camera);
  for (int i = 0; i < split->count(); i++) {
    split->setStretch(i, 1);
  }

  frogpilot_nvg = new FrogPilotAnnotatedCameraWidget(this);
  frogpilot_onroad = new FrogPilotOnroadWindow(this);
  frogpilot_onroad->setAttribute(Qt::WA_TransparentForMouseEvents, true);

  stacked_layout->addWidget(frogpilot_nvg);
  stacked_layout->addWidget(frogpilot_onroad);

  frogpilot_onroad->raise();

  nvg->frogpilot_nvg = frogpilot_nvg;
}

void OnroadWindow::updateState(const UIState &s, const FrogPilotUIState &fs) {
  if (!s.scene.started) {
    return;
  }

  alerts->updateState(s, fs);
  nvg->updateState(s, fs);

  QColor bgColor = bg_colors[s.status];
  if (bg != bgColor) {
    // repaint border
    bg = bgColor;
    update();
  }

  // FrogPilot variables
  const FrogPilotUIScene &frogpilot_scene = fs.frogpilot_scene;
  const QJsonObject &frogpilot_toggles = frogpilot_scene.frogpilot_toggles;

  frogpilot_nvg->alertHeight = alerts->alertHeight;

  frogpilot_onroad->bg = bg;
  frogpilot_onroad->fps = nvg->fps;

  nvg->frogpilot_nvg = frogpilot_nvg;

  nvg->frogpilot_scene = frogpilot_scene;
  frogpilot_nvg->frogpilot_scene = frogpilot_scene;
  frogpilot_onroad->frogpilot_scene = frogpilot_scene;

  alerts->frogpilot_toggles = frogpilot_toggles;
  frogpilot_nvg->frogpilot_toggles = frogpilot_toggles;
  frogpilot_onroad->frogpilot_toggles = frogpilot_toggles;
  nvg->frogpilot_toggles = frogpilot_toggles;

  frogpilot_onroad->setGeometry(rect());

  const auto carState = (*s.sm)["carState"].getCarState();
  bool blinkerLeft = carState.getLeftBlinker();
  bool blinkerRight = carState.getRightBlinker();
  bool showBlindSpotCamera = frogpilot_toggles.value("blind_spot_camera").toBool() && (blinkerLeft != blinkerRight);

  if (showBlindSpotCamera) {
    // signalled side gets its own half of the screen, the road keeps the other
    int cameraIndex = blinkerLeft ? 0 : split->count() - 1;
    if (split->indexOf(blind_spot_camera) != cameraIndex) {
      split->removeWidget(blind_spot_camera);
      split->insertWidget(cameraIndex, blind_spot_camera);

      for (int i = 0; i < split->count(); i++) {
        split->setStretch(i, 1);
      }
    }

    blind_spot_camera->setSide(blinkerLeft);
  }
  blind_spot_camera->setVisible(showBlindSpotCamera);

  frogpilot_nvg->updateState(s, fs);
  frogpilot_onroad->updateState(s, fs);
}

void OnroadWindow::offroadTransition(bool offroad) {
  alerts->clear();
}

void OnroadWindow::paintEvent(QPaintEvent *event) {
  QPainter p(this);
  p.fillRect(rect(), QColor(bg.red(), bg.green(), bg.blue(), 255));
}

// FrogPilot variables
void OnroadWindow::mousePressEvent(QMouseEvent* mouseEvent) {
  frogpilot_nvg->mousePressEvent(mouseEvent);

  if (mouseEvent->isAccepted()) {
    return;
  }

  // propagation event to parent(HomeWindow)
  QWidget::mousePressEvent(mouseEvent);
}
