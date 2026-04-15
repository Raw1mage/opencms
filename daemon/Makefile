CC      ?= gcc
CFLAGS  := -O2 -Wall -Wextra -Wpedantic -D_GNU_SOURCE
LDFLAGS := -lpam -lpam_misc -lcrypto -lcurl

TARGET  := opencode-gateway
SRC     := opencode-gateway.c

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGET)

install: $(TARGET)
	install -m 4755 -o root $(TARGET) /usr/local/bin/$(TARGET)
