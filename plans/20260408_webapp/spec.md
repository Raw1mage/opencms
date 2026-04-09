# Spec

## Purpose

- 讓 webapp session 的文字輸入框提供可直接使用的語音輸入能力；桌面維持即時語音辨識，手機提供錄音轉寫路徑，並在不支援或失敗時保持明確、可觀測且不誤導的互動。

## Requirements

### Requirement: Voice input entry point

The system SHALL provide a voice-input control in the webapp session prompt input surface.

#### Scenario: supported browser starts voice input

- **GIVEN** 使用者位於 webapp session 頁面，且瀏覽器支援 `SpeechRecognition` 或 `webkitSpeechRecognition`
- **WHEN** 使用者點擊 prompt input 的語音輸入按鈕
- **THEN** 系統開始語音辨識並將 UI 切換到錄音中狀態

### Requirement: Mobile voice path

The system SHALL provide a usable mobile voice-input path for iPhone-class browsers.

#### Scenario: mobile browser uses alternate path

- **GIVEN** 使用者位於手機瀏覽器，且該瀏覽器不可靠支援 `SpeechRecognition`
- **WHEN** 使用者嘗試使用語音輸入
- **THEN** 系統應走錄音 + 轉寫路徑，而不是只依賴桌面即時辨識能力

### Requirement: Transcript integrates into prompt editor

The system SHALL integrate speech recognition transcript output into the existing prompt editor and prompt state without bypassing prompt ownership.

#### Scenario: interim and final transcript arrive

- **GIVEN** 語音辨識正在進行
- **WHEN** browser speech recognition 產生 interim 與 final transcript
- **THEN** prompt editor 應顯示目前辨識文字，且 final transcript 需被寫入可繼續編輯與送出的 prompt state

### Requirement: Unsupported browsers fail fast

The system SHALL clearly expose when browser speech recognition is unavailable.

#### Scenario: browser lacks speech recognition support

- **GIVEN** 使用者使用不支援 `SpeechRecognition` 的瀏覽器
- **WHEN** 使用者看到或操作 prompt input 的語音輸入入口
- **THEN** 系統必須明確表達語音輸入不可用，而不是靜默沒有反應

### Requirement: Desktop and mobile paths remain distinct

The system SHALL keep desktop speech recognition and mobile recording/transcription responsibilities separate.

#### Scenario: route selection is explicit

- **GIVEN** 瀏覽器同時可能支援或不支援即時辨識
- **WHEN** 使用者啟動語音輸入
- **THEN** 系統必須清楚選擇桌面即時辨識或手機錄音轉寫其中一路，不得混用為單一路徑假設

### Requirement: Recording lifecycle is explicit

The system SHALL provide explicit recording lifecycle controls and cleanup.

#### Scenario: user stops recording

- **GIVEN** 語音辨識目前正在錄音
- **WHEN** 使用者再次點擊語音輸入控制、離開元件、或錄音因錯誤終止
- **THEN** 系統必須停止錄音、清除暫態 recording UI，並保留已提交的 final transcript

### Requirement: Existing prompt actions remain valid

The system SHALL preserve existing prompt input behaviors while voice input is added.

#### Scenario: user continues normal prompt actions

- **GIVEN** 語音輸入功能已存在於 prompt input
- **WHEN** 使用者繼續使用鍵盤輸入、附加圖片/PDF、切 shell mode、或送出 prompt
- **THEN** 既有行為不得因語音功能而失效或改變語義

## Acceptance Checks

- 在支援瀏覽器中可從 `prompt-input` 啟動與停止語音輸入，並看到錄音中狀態。
- final transcript 會留在 prompt editor 中，可被手動修改後再送出。
- 手機瀏覽器可使用錄音轉寫路徑取得文字輸入。
- unsupported browser path 有明確 UI 提示，且沒有 silent failure。
- 既有 attach / send / stop / shell-mode 互動維持可用。
