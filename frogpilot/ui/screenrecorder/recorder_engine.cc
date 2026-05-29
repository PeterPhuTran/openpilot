#include "frogpilot/ui/screenrecorder/recorder_engine.h"

#include <chrono>

#include <QDateTime>
#include <QDir>

#include "common/swaglog.h"
#include "common/timing.h"
#include "common/util.h"

namespace {
const QString RECORDINGS_DIR = "/data/media/screen_recordings";
constexpr uint64_t MAX_SEGMENT_NS = 5ULL * 60 * 1000000000ULL;
}

RecorderEngine::RecorderEngine(int width, int height, int fps, int bitrate) : bitrate(bitrate), fps(fps), height(height), width(width) {}

RecorderEngine::~RecorderEngine() {
  stop();
}

QImage RecorderEngine::blend_frames(const QImage &a, const QImage &b) {
  QImage out(a.size(), a.format());

  const uint8_t *pa = a.constBits();
  const uint8_t *pb = b.constBits();

  uint8_t *po = out.bits();

  const int n = a.bytesPerLine() * a.height();

  for (int i = 0; i < n; i++) {
    po[i] = (uint8_t)((pa[i] + pb[i]) >> 1);
  }

  return out;
}

bool RecorderEngine::open_segment() {
  encoder = std::make_unique<ScreenEncoder>(width, height, fps, bitrate);

  if (!encoder->open(segment_path())) {
    encoder.reset();
    return false;
  }

  segment_start_ns = nanos_since_boot();

  return true;
}

std::string RecorderEngine::segment_path() const {
  QString name = QDateTime::currentDateTime().toString("MMMM_dd_yyyy-hh-mmAP") + ".mp4";
  return (RECORDINGS_DIR + "/" + name).toStdString();
}

bool RecorderEngine::start() {
  if (recording) {
    return true;
  }

  QDir().mkpath(RECORDINGS_DIR);
  if (!open_segment()) {
    LOGE("screenrecorder: failed to start encoder");
    return false;
  }

  recording = true;

  worker = std::thread(&RecorderEngine::worker_loop, this);

  return true;
}

void RecorderEngine::stop() {
  if (!recording) {
    return;
  }

  recording = false;

  q_cv.notify_all();

  if (worker.joinable()) {
    worker.join();
  }

  {
    std::lock_guard<std::mutex> lk(q_mutex);
    queue.clear();
  }
  encoder.reset();
}

void RecorderEngine::submit_frame(QImage &&frame, uint64_t ts_ns) {
  if (!recording) {
    return;
  }

  {
    std::lock_guard<std::mutex> lk(q_mutex);
    if (queue.size() >= MAX_QUEUE) {
      queue.pop_front();
    }
    queue.push_back({std::move(frame), ts_ns});
  }
  q_cv.notify_one();
}

void RecorderEngine::worker_loop() {
  util::set_thread_name("sr-capture");

  QImage prev_image;

  uint64_t prev_ts = 0;

  while (recording) {
    CapturedFrame cf;
    {
      std::unique_lock<std::mutex> lk(q_mutex);
      q_cv.wait_for(lk, std::chrono::milliseconds(100),
                    [this] { return !queue.empty() || !recording; });

      if (!recording) {
        break;
      }

      if (queue.empty()) {
        continue;
      }

      cf = std::move(queue.front());
      queue.pop_front();
    }

    if (nanos_since_boot() - segment_start_ns > MAX_SEGMENT_NS) {
      encoder.reset();

      if (!open_segment()) {
        LOGE("screenrecorder: segment rotation failed, stopping");
        recording = false;
        break;
      }

      prev_image = QImage();

      prev_ts = 0;
    }

    if (!encoder || !encoder->is_open) {
      recording = false;
      break;
    }

    if (cf.image.format() != QImage::Format_RGB32) {
      cf.image = cf.image.convertToFormat(QImage::Format_RGB32);
    }

    if (!prev_image.isNull() && prev_image.size() == cf.image.size()) {
      uint64_t mid_ts = prev_ts + (cf.ts_ns - prev_ts) / 2;
      QImage mid = blend_frames(prev_image, cf.image);
      encoder->encode_frame(mid.constBits(), mid.bytesPerLine(), mid_ts);
    }
    encoder->encode_frame(cf.image.constBits(), cf.image.bytesPerLine(), cf.ts_ns);

    prev_image = cf.image;
    prev_ts = cf.ts_ns;
  }
}
