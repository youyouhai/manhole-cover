"""Read non-secret device identifiers from a serial port before flashing."""

import sys
import time

import serial


port = sys.argv[1]
with serial.Serial(port, 115200, timeout=0.5) as connection:
    deadline = time.time() + 5
    found = []
    while time.time() < deadline:
        line = connection.readline().decode("utf-8", "ignore").strip()
        if any(mark in line for mark in ("GOOUUU", "[camera]", "MH001", "[wifi]")):
            found.append(line[:160])
    print("Device identifiers:", found[:8])
