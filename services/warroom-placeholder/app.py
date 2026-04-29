import json
import os
import signal
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PORT = int(os.environ.get("WARROOM_PLACEHOLDER_PORT", "8000"))
EVENT_INTERVAL_SECONDS = float(os.environ.get("WARROOM_SYNTHETIC_INTERVAL_SECONDS", "10"))
LOKI_URL = os.environ.get("WARROOM_LOKI_URL", "http://loki:3100/loki/api/v1/push")

START_TIME = time.time()
STOP = threading.Event()
LOCK = threading.Lock()
METRICS = {
    "events_total": 0,
    "incidents_total": 0,
    "capability_gaps_total": 0,
    "last_event_timestamp": 0,
}


def now_ns():
    return str(time.time_ns())


def update_metrics(event):
    with LOCK:
        METRICS["events_total"] += 1
        METRICS["last_event_timestamp"] = int(time.time())
        if event["event_type"] == "synthetic_incident_candidate":
            METRICS["incidents_total"] += 1
        if event["event_type"] == "synthetic_capability_gap":
            METRICS["capability_gaps_total"] += 1


def synthetic_event(sequence):
    patterns = [
        ("synthetic_dlp_event", "mass_rename_burst", "medium"),
        ("synthetic_dlp_event", "failed_login_burst_then_success", "high"),
        ("synthetic_capability_gap", "nas_session_log_unavailable", "info"),
        ("synthetic_incident_candidate", "permission_broadening", "high"),
    ]
    event_type, rule_id, severity = patterns[sequence % len(patterns)]
    return {
        "service": "warroom-placeholder",
        "environment": "local-poc",
        "synthetic": True,
        "event_id": f"synthetic-{sequence:06d}",
        "event_type": event_type,
        "rule_id": rule_id,
        "severity": severity,
        "nas_host": "synthetic-rawdb",
        "monitored_folder_id": "synthetic-raw1mage",
        "folder_path_safe": "~Raw1mage",
        "actor": "synthetic-user",
        "source_ip": "192.0.2.10",
        "action": "metadata_only_observation",
        "confidence": 0.75,
    }


def emit_loki(event, line):
    body = json.dumps(
        {
            "streams": [
                {
                    "stream": {
                        "job": "warroom-placeholder",
                        "service": "warroom-placeholder",
                        "synthetic": "true",
                    },
                    "values": [[now_ns(), line]],
                }
            ]
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        LOKI_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(json.dumps({"service": "warroom-placeholder", "synthetic": True, "loki_push_error": str(error)}), flush=True)


def producer_loop():
    sequence = 0
    while not STOP.is_set():
        event = synthetic_event(sequence)
        line = json.dumps(event, separators=(",", ":"))
        print(line, flush=True)
        update_metrics(event)
        emit_loki(event, line)
        sequence += 1
        STOP.wait(EVENT_INTERVAL_SECONDS)


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return

        with LOCK:
            snapshot = dict(METRICS)
        uptime = time.time() - START_TIME
        body = "\n".join(
            [
                "# HELP warroom_placeholder_up Warroom placeholder service health.",
                "# TYPE warroom_placeholder_up gauge",
                "warroom_placeholder_up 1",
                "# HELP warroom_placeholder_uptime_seconds Warroom placeholder uptime in seconds.",
                "# TYPE warroom_placeholder_uptime_seconds gauge",
                f"warroom_placeholder_uptime_seconds {uptime:.3f}",
                "# HELP warroom_synthetic_dlp_events_total Synthetic Warroom DLP-like events emitted.",
                "# TYPE warroom_synthetic_dlp_events_total counter",
                f"warroom_synthetic_dlp_events_total {snapshot['events_total']}",
                "# HELP warroom_synthetic_incidents_total Synthetic Warroom incident candidates emitted.",
                "# TYPE warroom_synthetic_incidents_total counter",
                f"warroom_synthetic_incidents_total {snapshot['incidents_total']}",
                "# HELP warroom_synthetic_capability_gaps_total Synthetic capability gaps emitted.",
                "# TYPE warroom_synthetic_capability_gaps_total counter",
                f"warroom_synthetic_capability_gaps_total {snapshot['capability_gaps_total']}",
                "# HELP warroom_synthetic_last_event_timestamp_seconds Last synthetic event timestamp.",
                "# TYPE warroom_synthetic_last_event_timestamp_seconds gauge",
                f"warroom_synthetic_last_event_timestamp_seconds {snapshot['last_event_timestamp']}",
                "",
            ]
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def stop(_signum, _frame):
    STOP.set()


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    producer = threading.Thread(target=producer_loop, daemon=True)
    producer.start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), MetricsHandler)
    while not STOP.is_set():
        server.handle_request()
    server.server_close()


if __name__ == "__main__":
    main()
