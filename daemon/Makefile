CC      ?= gcc
CFLAGS  := -O2 -Wall -Wextra -Wpedantic -D_GNU_SOURCE
LDFLAGS := -lpam -lpam_misc -lcrypto -lcurl

TARGET  := opencode-gateway
SRC     := opencode-gateway.c

.PHONY: all clean install test

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

test-orphan-cleanup: test-orphan-cleanup.c
	$(CC) $(CFLAGS) -o $@ $<

test: test-orphan-cleanup
	./test-orphan-cleanup

clean:
	rm -f $(TARGET) test-orphan-cleanup

install: $(TARGET)
	install -m 4755 -o root $(TARGET) /usr/local/bin/$(TARGET)
