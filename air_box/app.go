package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"go.bug.st/serial" // 序列埠函式庫， `go get go.bug.st/serial`
)

// App struct
type App struct {
	ctx               context.Context
	currentPM25       float64
	pm25History       []PM25Data
	mu                sync.RWMutex // 保護共享資源
	serialPort        serial.Port
	isSoundEnabled    bool
	lastAQILevel      string
	lastMascotMessage string
	connectedPortName string        // 記錄目前連接的序列埠名稱
	stopSerialReader  chan struct{} // 用於通知 serial reader goroutine 停止
}

// PM25Data struct for historical data
type PM25Data struct {
	Timestamp int64   `json:"timestamp"` // Unix timestamp
	Value     float64 `json:"value"`
}

// AQIInfo struct for AQI level and color
type AQIInfo struct {
	Level     string  `json:"level"` // e.g., "良好", "普通", "不健康"
	Color     string  `json:"color"` // e.g., "green", "yellow", "red"
	PM25      float64 `json:"pm25"`
	Message   string  `json:"message"`   // 看板娘訊息
	SoundFile string  `json:"soundFile"` // 新增：音檔標識符 (e.g., "1", "startup")
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		isSoundEnabled: true, // 預設開啟語音
		pm25History:    make([]PM25Data, 0),
	}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	runtime.EventsEmit(a.ctx, "mascot_message", map[string]interface{}{
		"message":    "空氣盒子已啟動！請選擇序列埠並連接...",
		"play_sound": a.isSoundEnabled,
		"sound_file": "startup", // 假設你的啟動音效是 startup.mp3
	})
	a.lastMascotMessage = "空氣盒子已啟動！請選擇序列埠並連接..."

	// 啟動一個 goroutine 定期刷新序列埠列表並通知前端
	go a.pollSerialPorts()
}

// pollSerialPorts 定期檢查序列埠列表並通知前端
func (a *App) pollSerialPorts() {
	ticker := time.NewTicker(5 * time.Second) // 每 5 秒刷新一次
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ports, err := serial.GetPortsList()
			if err != nil {
				log.Printf("定時獲取序列埠列表錯誤: %v", err)
				// 可以考慮向前端發送一個錯誤事件
				continue
			}
			// log.Printf("定時刷新序列埠: %v", ports)
			runtime.EventsEmit(a.ctx, "serial_ports_updated", ports)
		case <-a.ctx.Done(): // App 關閉時退出
			log.Println("停止定時刷新序列埠")
			return
		}
	}
}

// ListSerialPorts 列出可用的序列埠
func (a *App) ListSerialPorts() ([]string, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}
	if len(ports) == 0 {
		return nil, fmt.Errorf("找不到任何序列埠")
	}
	var portNames []string
	portNames = append(portNames, ports...)
	return portNames, nil
}

// ConnectSerialPort 連接指定的序列埠
func (a *App) ConnectSerialPort(portName string) (string, error) {
	// 先關閉已有的連接
	a.mu.Lock()
	if a.serialPort != nil {
		log.Printf("ConnectSerialPort: 正在關閉舊的序列埠連接: %s", a.connectedPortName)
		if a.stopSerialReader != nil {
			close(a.stopSerialReader) // 通知舊的 reader goroutine 停止
			// 不需要等待，reader goroutine 會自行退出
			a.stopSerialReader = nil
		}
		a.serialPort.Close()
		a.serialPort = nil
		a.connectedPortName = ""
	}
	a.mu.Unlock() // 解鎖，讓 serial.Open 在鎖外執行，避免長時間阻塞

	mode := &serial.Mode{
		BaudRate: 9600,
	}
	log.Printf("ConnectSerialPort: 嘗試開啟序列埠 %s", portName)
	port, err := serial.Open(portName, mode)
	if err != nil {
		log.Printf("ConnectSerialPort: 無法開啟序列埠 %s: %v", portName, err)
		return "", fmt.Errorf("無法開啟序列埠 %s: %v", portName, err)
	}
	log.Printf("ConnectSerialPort: 成功開啟序列埠 %s, 準備更新 App 狀態", portName)

	a.mu.Lock()
	// 再次檢查，防止在 Open 期間，有其他操作（如 shutdown）關閉了 App 的意願
	// 或者，如果應用邏輯允許並行連接嘗試（雖然此處不允許），這裡需要處理
	if a.ctx.Err() != nil { // 檢查 App 是否已關閉
		a.mu.Unlock()
		port.Close() // 關閉剛剛打開的 port
		return "", fmt.Errorf("App 正在關閉，無法連接序列埠")
	}

	// 理論上，因為我們上面已經關閉了 a.serialPort，這裡它應該是 nil
	// 如果不是 nil，說明在 Lock/Unlock 期間有其他 goroutine 修改了它，這是更深層次的同步問題
	if a.serialPort != nil {
		a.mu.Unlock()
		port.Close()
		log.Printf("ConnectSerialPort: 發現意外的現有連接 %s，連接衝突", a.connectedPortName)
		return "", fmt.Errorf("連接序列埠時發生衝突，請重試")
	}

	a.serialPort = port
	a.connectedPortName = portName
	a.stopSerialReader = make(chan struct{})
	go a.readSerialData(a.stopSerialReader) // 啟動新的 reader
	a.mu.Unlock()

	log.Printf("成功連接到序列埠: %s\n", portName)
	runtime.EventsEmit(a.ctx, "serial_status_changed", map[string]interface{}{"status": "connected", "port": portName})
	return fmt.Sprintf("已連接到 %s", portName), nil
}

// DisconnectSerialPort 主動斷開序列埠連接
func (a *App) DisconnectSerialPort() (string, error) {
	a.mu.Lock()         // 加鎖保護共享資源的訪問和修改
	defer a.mu.Unlock() // 確保在函數返回時解鎖

	if a.serialPort == nil {
		log.Println("DisconnectSerialPort: 序列埠未連接或已被關閉")
		return "序列埠未連接", nil
	}

	log.Printf("DisconnectSerialPort: 正在手動斷開序列埠連接: %s", a.connectedPortName)
	if a.stopSerialReader != nil {
		close(a.stopSerialReader)
		a.stopSerialReader = nil
	}

	err := a.serialPort.Close()
	a.serialPort = nil // 清理引用
	oldPortName := a.connectedPortName
	a.connectedPortName = "" // 清理名稱

	if err != nil {
		log.Printf("DisconnectSerialPort: 關閉序列埠 %s 時發生錯誤: %v", oldPortName, err)
		// 即使關閉出錯，我們也認為它斷開了，所以依然發送 disconnected 事件
		runtime.EventsEmit(a.ctx, "serial_status_changed", map[string]interface{}{"status": "error_on_disconnect", "port": oldPortName, "message": err.Error()})
		return "", fmt.Errorf("關閉序列埠 %s 時發生錯誤: %v", oldPortName, err)
	}

	log.Printf("DisconnectSerialPort: 成功從 %s 斷開連接", oldPortName)
	runtime.EventsEmit(a.ctx, "serial_status_changed", map[string]interface{}{"status": "disconnected", "port": oldPortName})
	return fmt.Sprintf("已從 %s 斷開連接", oldPortName), nil
}

// readSerialData Goroutine
func (a *App) readSerialData(stopCh <-chan struct{}) { // 接收 stop channel
	// 確保在 goroutine 開始時，serialPort 依然有效
	a.mu.RLock()
	currentPort := a.serialPort
	currentPortName := a.connectedPortName
	a.mu.RUnlock()

	if currentPort == nil {
		log.Println("readSerialData 錯誤: 序列埠未連接或已在啟動前斷開")
		return
	}

	reader := bufio.NewReader(currentPort)
	log.Printf("開始讀取序列埠 %s 的數據...\n", currentPortName)

	for {
		select {
		case <-stopCh: // 如果收到停止信號
			log.Printf("停止讀取序列埠 %s 的數據 (外部請求)\n", currentPortName)
			return
		default:
			// 設定一個讀取超時，避免 ReadString 長時間阻塞，以便能響應 stopCh
			// 如果 serial 庫的 ReadString 本身可以被 Close 中斷，則不需要這麼複雜
			// 但為了更安全地退出，可以考慮使用帶超時的讀取，或用更底層的 Read + buffer
			// bufio.Reader 的 ReadString 在 port.Close() 時通常會返回錯誤，可以用這個機制
			line, err := reader.ReadString('\n')
			if err != nil {
				// ★★★ 關鍵調試點 ★★★
				log.Printf("DEBUG: readSerialData from %s - ReadString error: %T, %v", currentPortName, err, err)

				// 檢查是否是 io.EOF 或其他特定錯誤
				if err == io.EOF {
					log.Printf("DEBUG: readSerialData from %s - Got EOF, port likely closed.", currentPortName)
				}
				// 根據 serial 庫的文檔，檢查端口關閉時 ReadString 返回的具體錯誤類型
				// 例如，可能是 *serial.PortError 或 syscall.Errno

				// 暫時簡化錯誤處理，如果出錯就直接退出 goroutine 並通知
				a.mu.Lock()
				// 只有當錯誤發生在這個 goroutine 認為自己還應該在運行的端口上時，才去操作 a.serialPort
				if a.connectedPortName == currentPortName && a.serialPort != nil {
					log.Printf("Closing port %s due to read error: %v", currentPortName, err)
					a.serialPort.Close() // 確保關閉
					a.serialPort = nil
					a.connectedPortName = ""
					// 不需要再關閉 stopSerialReader，因為這個 goroutine 即將退出
				}
				a.mu.Unlock()
				runtime.EventsEmit(a.ctx, "serial_status_changed", map[string]interface{}{"status": "error", "port": currentPortName, "message": fmt.Sprintf("Read error: %v", err)})
				return // 退出 goroutine
			}

			pm25Str := strings.TrimSpace(line)
			pm25Val, err := strconv.ParseFloat(pm25Str, 64)
			if err != nil {
				log.Printf("解析 PM2.5 數據錯誤 '%s' from %s: %v\n", pm25Str, currentPortName, err)
				// 可以發送一個解析錯誤的事件給前端
				runtime.EventsEmit(a.ctx, "data_parse_error", map[string]interface{}{"data": pm25Str, "error": err.Error()})
				continue
			}

			a.mu.Lock()
			a.currentPM25 = pm25Val
			now := time.Now()
			a.pm25History = append(a.pm25History, PM25Data{Timestamp: now.Unix(), Value: pm25Val})
			oneHourAgo := now.Add(-1 * time.Hour).Unix()
			cleanedHistory := make([]PM25Data, 0)
			for _, data := range a.pm25History {
				if data.Timestamp >= oneHourAgo {
					cleanedHistory = append(cleanedHistory, data)
				}
			}
			a.pm25History = cleanedHistory
			currentAqiInfo := a.calculateAQI(pm25Val) // calculateAQI 假設是純函數，不修改共享狀態
			a.mu.Unlock()

			runtime.EventsEmit(a.ctx, "pm25_updated", currentAqiInfo)

			if currentAqiInfo.Level != a.lastAQILevel {
				a.mu.Lock()
				a.lastAQILevel = currentAqiInfo.Level
				a.lastMascotMessage = currentAqiInfo.Message
				a.mu.Unlock()
				runtime.EventsEmit(a.ctx, "aqi_changed", map[string]interface{}{
					"aqiInfo":    currentAqiInfo, // 發送整個 AQIInfo 對象
					"play_sound": a.isSoundEnabled,
				})
			}
		}
	}
}

// calculateAQI 根據 PM2.5 計算 AQI 等級和顏色
func (a *App) calculateAQI(pm25 float64) AQIInfo {
	// 根據你提供的圖片
	// 0.0 - 15.4 -> 綠色 (良好)
	// 15.5 - 35.4 -> 黃色 (普通)
	// 35.5 - 54.4 -> 紅色 (對敏感族群不健康)
	// 你可以根據官方 AQI 標準擴展更多等級

	var level, color, message, soundFile string // 新增 soundFile

	if pm25 <= 15.4 {
		level = "良好"
		color = "green"
		message = "閣下，目前空氣品質良好，適宜戶外活動，請放心呼吸。"
		soundFile = "1" // 對應 1.mp3
	} else if pm25 <= 35.4 {
		level = "普通"
		color = "yellow"
		message = "閣下，空氣品質屬於普通範疇，雖不至於有害，但長時間暴露可能會感受到不適，請酌情安排戶外活動"
		soundFile = "2" // 對應 2.mp3
	} else if pm25 <= 54.4 {
		level = "對敏感族群不健康"
		color = "orange"
		message = "警告，目前空氣品質已達不健康等級，尤其是對於敏感群體，建議減少戶外活動。"
		soundFile = "3" // 對應 3.mp3
	} else if pm25 <= 150.4 {
		level = "對所有族群不健康"
		color = "red"
		message = "危險，空氣品質目前已達危害等級，對所有人群可能造成健康風險，請立即減少戶外活動並採取防護措施。"
		soundFile = "4" // 對應 4.mp3
	} else if pm25 <= 250.4 {
		level = "非常不健康"
		color = "purple"
		message = "危險已然迫近。"
		soundFile = "5" // 對應 5.mp3
	} else {
		level = "危害"
		color = "maroon"
		message = "危險已然迫近。"
		soundFile = "5" // 假設你有 6.mp3
	}

	return AQIInfo{Level: level, Color: color, PM25: pm25, Message: message, SoundFile: soundFile}
}

// GetInitialData 提供初始數據給前端
func (a *App) GetInitialData() map[string]interface{} {
	a.mu.RLock()
	defer a.mu.RUnlock()

	aqiInfo := a.calculateAQI(a.currentPM25)
	mascotMsg := a.lastMascotMessage
	if mascotMsg == "" {
		mascotMsg = "正在初始化空氣盒子..."
	}

	return map[string]interface{}{
		"currentPM25":    a.currentPM25,
		"pm25History":    a.pm25History,
		"aqiInfo":        aqiInfo,
		"isSoundEnabled": a.isSoundEnabled,
		"mascotMessage":  mascotMsg,
		"connectedPort":  a.connectedPortName, // 新增：告知前端目前連接的埠
	}
}

// ToggleSound 開關語音提示
func (a *App) ToggleSound(enable bool) {
	a.mu.Lock()
	a.isSoundEnabled = enable
	a.mu.Unlock()
	log.Printf("語音提示已 %s\n", map[bool]string{true: "開啟", false: "關閉"}[enable])
}

// GetPM25History 返回歷史數據 (如果需要前端主動獲取)
func (a *App) GetPM25History() []PM25Data {
	a.mu.RLock()
	defer a.mu.RUnlock()
	// 返回一個副本以避免併發問題
	historyCopy := make([]PM25Data, len(a.pm25History))
	copy(historyCopy, a.pm25History)
	return historyCopy
}

// shutdown (確保停止 serial reader)
func (a *App) shutdown(ctx context.Context) {
	log.Println("App 正在關閉...")
	a.mu.Lock() // 加鎖以安全地操作共享資源
	if a.stopSerialReader != nil {
		log.Println("發送停止信號給 serial reader...")
		close(a.stopSerialReader) // 確保 reader goroutine 會退出
		a.stopSerialReader = nil
	}
	if a.serialPort != nil {
		log.Println("關閉序列埠...")
		a.serialPort.Close()
		a.serialPort = nil
	}
	a.mu.Unlock()
	log.Println("App 關閉完成。")
}
