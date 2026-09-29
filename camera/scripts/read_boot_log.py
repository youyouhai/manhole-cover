"""Reset an ESP32 through the USB serial control lines and print its boot log."""

import argparse
import time

import serial


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--seconds", type=float, default=30)
    args = parser.parse_args()

    with serial.Serial(args.port, args.baud, timeout=0.25) as connection:
        # Standard ESP32 auto-reset: assert reset briefly without holding GPIO0.
        connection.dtr = False
        connection.rts = True
        time.sleep(0.15)
        connection.rts = False
        time.sleep(0.15)
        connection.reset_input_buffer()

        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            data = connection.read(connection.in_waiting or 1)
            if data:
                print(data.decode("utf-8", errors="replace"), end="", flush=True)


if __name__ == "__main__":
    main()
