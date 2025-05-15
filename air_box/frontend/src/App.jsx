// frontend/src/App.js

import React, { useState, useEffect, useRef, useCallback } from 'react'; // 添加 useCallback
import { ListSerialPorts, ConnectSerialPort, DisconnectSerialPort, GetInitialData, ToggleSound } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime';
import { Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    TimeScale,
} from 'chart.js';
import 'chartjs-adapter-date-fns';

import './App.css';
import mascotImage from './assets/images/images.jpg';

import sound1 from './assets/voice/1.mp3';
import sound2 from './assets/voice/2.mp3';
import sound3 from './assets/voice/3.mp3';
import sound4 from './assets/voice/4.mp3';
import sound5 from './assets/voice/5.mp3';
// import sound6 from './assets/voice/6.mp3'; // 如果有第6個AQI等級的聲音
import soundStartup from './assets/voice/startup.wav'; // 注意你這裡用的是 .wav
// import soundConnectSuccess from './assets/voice/connect_success.mp3'; // 示例
// import soundToggleOn from './assets/voice/sound_on.mp3'; // 示例
// import soundToggleOff from './assets/voice/sound_off.mp3'; // 示例


const soundMap = {
    "1": sound1,
    "2": sound2,
    "3": sound3,
    "4": sound4,
    "5": sound5,
    // "6": sound6,
    "startup": soundStartup,
    // "connect_success": soundConnectSuccess,
    // "sound_on": soundToggleOn,
    // "sound_off": soundToggleOff,
};

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    TimeScale
);

const getAQIColorForValue = (pm25) => {
    // ★★★ 根據你提供的圖片 PM2.5 與顏色的對應關係 ★★★
    // 0.0 - 15.4 -> 綠色
    // 15.5 - 35.4 -> 黃色
    // 35.5 - 54.4 -> 紅色
    // 請確保這個邏輯與你期望的視覺效果完全一致
    if (pm25 <= 15.4) return 'green';
    if (pm25 <= 35.4) return 'yellow';
    if (pm25 <= 54.4) return 'red'; // 根據你的圖片，這個區間是紅色

    // 如果還有更高等級的 PM2.5 對應不同顏色，可以在此添加
    // 例如：
    if (pm25 <= 150.4) return 'purple'; // 假設的更高一級
    if (pm25 <= 250.4) return 'maroon'; // 假設的再高一級

    return '#ccc'; // 如果沒有匹配，返回一個默認的中性色
};


function App() {
    const [ports, setPorts] = useState([]);
    const [selectedPort, setSelectedPort] = useState('');
    const [connectionStatus, setConnectionStatus] = useState('未連接');
    const [connectedPortName, setConnectedPortName] = useState('');
    const [currentPM25, setCurrentPM25] = useState(0);
    const [aqiInfo, setAqiInfo] = useState(null);
    const [pm25History, setPm25History] = useState([]); // 原始數據歷史
    const [mascotMessage, setMascotMessage] = useState('歡迎使用空氣品質監測！');
    const [isSoundOn, setIsSoundOn] = useState(true);
    const [isConnecting, setIsConnecting] = useState(false);

    const audioRef = useRef(null);

    const [downsampledChartHistory, setDownsampledChartHistory] = useState([]);
    const SAMPLING_INTERVAL_MS = 5 * 60 * 10; // ★★★ 5分鐘的毫秒數 ★★★
    const lastSampledTimeRef = useRef(0);

    const playSound = useCallback((soundFileIdentifier) => {
        if (!audioRef.current) {
            console.error("Audio element ref is not yet available. Cannot play sound:", soundFileIdentifier);
            return;
        }
        if (isSoundOn && soundMap[soundFileIdentifier]) {
            if (!audioRef.current.paused) {
                audioRef.current.pause();
            }
            audioRef.current.currentTime = 0;
            audioRef.current.src = soundMap[soundFileIdentifier];
            const playPromise = audioRef.current.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error(`播放音效 ${soundFileIdentifier} (src: ${soundMap[soundFileIdentifier]}) 失敗:`, error);
                });
            }
        } else if (isSoundOn && !soundMap[soundFileIdentifier]) {
            console.warn(`未找到音效文件對應的標識符: ${soundFileIdentifier}`);
        }
    }, [isSoundOn]); // 依賴 isSoundOn

    useEffect(() => {
        ListSerialPorts()
            .then(initialPorts => setPorts(initialPorts || []))
            .catch(err => {
                console.error("初始獲取序列埠失敗:", err);
                setConnectionStatus("獲取序列埠列表失敗");
            });

        GetInitialData().then(data => {
            if (data) {
                setIsSoundOn(data.isSoundEnabled === undefined ? true : data.isSoundEnabled);
                setMascotMessage(data.mascotMessage || "請連接 Arduino 設備。");

                if (data.connectedPort) {
                    setConnectedPortName(data.connectedPort);
                    setConnectionStatus(`已連接到 ${data.connectedPort}`);
                    setSelectedPort(data.connectedPort);
                    setCurrentPM25(data.currentPM25 || 0);
                    setAqiInfo(data.aqiInfo || null); // 後端應包含 soundFile
                    setPm25History(data.pm25History || []);
                    // 啟動時，即使已連接，也等待新數據進行5分鐘採樣
                    setDownsampledChartHistory([]);
                    lastSampledTimeRef.current = 0;
                } else {
                    setCurrentPM25(0);
                    setAqiInfo(null);
                    setPm25History([]);
                    setDownsampledChartHistory([]);
                    lastSampledTimeRef.current = 0;
                }
            } else {
                lastSampledTimeRef.current = 0;
                setDownsampledChartHistory([]);
                setPm25History([]);
            }
        }).catch(err => {
            console.error("Error fetching initial data:", err);
            lastSampledTimeRef.current = 0;
            setDownsampledChartHistory([]);
            setPm25History([]);
        });
    }, []);

    useEffect(() => {
        const cleanupFunctions = [];
        cleanupFunctions.push(EventsOn('serial_ports_updated', (updatedPorts) => {
            setPorts(updatedPorts || []);
            if (!connectedPortName && selectedPort && !(updatedPorts || []).includes(selectedPort)) {
                setSelectedPort('');
            }
        }));

        cleanupFunctions.push(EventsOn('serial_status_changed', (payload) => {
            setIsConnecting(false);
            if (payload) {
                switch (payload.status) {
                    case 'connected':
                        setConnectionStatus(`已連接到 ${payload.port}`);
                        setConnectedPortName(payload.port);
                        setSelectedPort(payload.port);
                        // 連接成功時，後端可以發送一個帶 sound_file 的 mascot_message
                        // setMascotMessage(`成功連接到 ${payload.port}！`);
                        // playSound("connect_success"); // 假設有此音效
                        break;
                    case 'disconnected':
                        setConnectionStatus(`已從 ${payload.port} 斷開`);
                        if (connectedPortName === payload.port) {
                            setConnectedPortName('');
                            setCurrentPM25(0);
                            setAqiInfo(null);
                            setPm25History([]);
                            setDownsampledChartHistory([]);
                            lastSampledTimeRef.current = 0;
                        }
                        setMascotMessage(`已從 ${payload.port} 斷開連接。`);
                        break;
                    // ... (其他 case: error, error_on_disconnect)
                    case 'error':
                        setConnectionStatus(`連接 ${payload.port || '埠'} 錯誤: ${payload.message}`);
                        if (connectedPortName === payload.port) {
                            setConnectedPortName('');
                        }
                        setMascotMessage(`連接埠 ${payload.port || ''} 時發生錯誤！`);
                        break;
                    case 'error_on_disconnect':
                         setConnectionStatus(`從 ${payload.port} 斷開時出錯: ${payload.message}`);
                         if (connectedPortName === payload.port) {
                            setConnectedPortName('');
                         }
                         setMascotMessage(`從 ${payload.port} 斷開時出錯。`);
                        break;
                    default:
                        setConnectionStatus('未知序列埠狀態');
                }
            }
        }));

        cleanupFunctions.push(EventsOn('pm25_updated', (data) => { // data 是 AQIInfo
            if (data && data.pm25 !== undefined && connectedPortName) {
                const currentTimeMs = Date.now();
                setCurrentPM25(data.pm25);
                setAqiInfo(data); // data 包含 soundFile

                const newRawEntry = { timestamp: currentTimeMs / 1000, value: data.pm25 };
                setPm25History(prev => {
                    const current = Array.isArray(prev) ? prev : [];
                    const oneHourAgoSec = (currentTimeMs / 1000) - 3600;
                    return [...current.filter(p => p.timestamp >= oneHourAgoSec), newRawEntry];
                });

                let shouldSampleNow = false;
                if (lastSampledTimeRef.current === 0) {
                    shouldSampleNow = true;
                } else {
                    const timeSinceLastSampleMs = currentTimeMs - lastSampledTimeRef.current;
                    if (timeSinceLastSampleMs >= SAMPLING_INTERVAL_MS) {
                        shouldSampleNow = true;
                    }
                }

                if (shouldSampleNow) {
                    console.log(
                        `★★★ SAMPLING POINT for chart ★★★ at ${new Date(currentTimeMs).toLocaleTimeString()}. ` +
                        `PM2.5: ${data.pm25.toFixed(2)}`
                    );
                    setDownsampledChartHistory(prev => {
                        const newPoint = { timestamp: currentTimeMs, value: data.pm25 };
                        const oneHourAgoMs = currentTimeMs - (60 * 60 * 1000);
                        const validSamples = (Array.isArray(prev) ? prev : []).filter(p => p.timestamp >= oneHourAgoMs);
                        return [...validSamples, newPoint];
                    });
                    lastSampledTimeRef.current = currentTimeMs;
                }
            }
        }));

        cleanupFunctions.push(EventsOn('aqi_changed', (payload) => {
            if (payload && payload.aqiInfo && connectedPortName) {
                setMascotMessage(payload.aqiInfo.message);
                if (payload.play_sound && payload.aqiInfo.soundFile) {
                    playSound(payload.aqiInfo.soundFile);
                }
            }
        }));

        cleanupFunctions.push(EventsOn('mascot_message', (payload) => {
            if (payload) {
                setMascotMessage(payload.message);
                if (payload.play_sound && payload.sound_file) {
                    playSound(payload.sound_file);
                }
            }
        }));

        cleanupFunctions.push(EventsOn('data_parse_error', (payload) => {
            console.error("後端數據解析錯誤:", payload);
            if (connectedPortName) {
                setMascotMessage(`警告：收到來自 ${connectedPortName} 的無法解析的數據 "${payload.data || ''}"`);
            }
        }));

        return () => {
            cleanupFunctions.forEach(cleanup => {
                if (typeof cleanup === 'function') cleanup();
            });
        };
    }, [isSoundOn, connectedPortName, downsampledChartHistory, playSound, SAMPLING_INTERVAL_MS]); // 主要依賴

    const handleConnect = () => {
        if (!selectedPort) {
            setMascotMessage('請先選擇一個序列埠');
            setConnectionStatus('請先選擇一個序列埠');
            return;
        }
        if (isConnecting) return;
        setIsConnecting(true);
        setConnectionStatus(`正在連接到 ${selectedPort}...`);
        setMascotMessage(`嘗試連接到 ${selectedPort}...`);
        setCurrentPM25(0);
        setAqiInfo(null);
        setPm25History([]);
        setDownsampledChartHistory([]);
        lastSampledTimeRef.current = 0;
        ConnectSerialPort(selectedPort)
            .catch(err => {
                setIsConnecting(false);
                console.error("連接失敗 (前端調用錯誤):", err);
                setConnectionStatus(`連接失敗: ${err.message || err}`);
                setMascotMessage(`連接 ${selectedPort} 失敗！`);
                setDownsampledChartHistory([]); // 確保失敗也清空
                lastSampledTimeRef.current = 0;
            });
    };

    const handleDisconnect = () => {
        if (!connectedPortName || isConnecting) return;
        setIsConnecting(true); // 用 isConnecting 標識操作中
        setMascotMessage(`正在從 ${connectedPortName} 斷開...`);
        DisconnectSerialPort()
            .catch(err => {
                setIsConnecting(false); // 即使出錯，也結束操作中狀態
                console.error("斷開連接失敗 (前端調用錯誤):", err);
                setMascotMessage(`斷開 ${connectedPortName} 時出錯: ${err.message || err}`);
            });
    };

    const handleToggleSound = () => {
        const newSoundState = !isSoundOn;
        setIsSoundOn(newSoundState);
        ToggleSound(newSoundState).catch(console.error);
        const message = newSoundState ? "語音提示已開啟。" : "語音提示已關閉。";
        setMascotMessage(message);
        // playSound(newSoundState ? "sound_on" : "sound_off"); // 假設有對應音效
    };

    // ★★★ Chart Data 和 Options 的構建 ★★★
    const chartData = {}; // 初始化為空對象

    if (Array.isArray(downsampledChartHistory) && downsampledChartHistory.length > 0) {
        const pointBackgroundColors = downsampledChartHistory.map(p => getAQIColorForValue(p.value));
        const pointBorderColors = pointBackgroundColors; // 簡單處理，邊框和背景同色

        chartData.datasets = [
            {
                label: 'PM2.5 (µg/m³)',
                data: downsampledChartHistory.map(p => ({ x: p.timestamp, y: p.value })),
                borderColor: '#888', // 統一的線條顏色
                tension: 0.2, // 可以調整曲線的平滑度
                fill: false,  // 不填充線條下方區域
                pointBackgroundColor: pointBackgroundColors,
                pointBorderColor: pointBorderColors,
                pointRadius: 5, // 稍大一點的點
                pointHoverRadius: 7,
                borderWidth: 2, // 線條寬度
            },
        ];
    } else {
        chartData.datasets = []; // 沒有數據時，確保 dataset 是空數組
    }

    const chartOptions = {
        scales: {
            x: {
                type: 'time',
                time: { unit: 'minute', tooltipFormat: 'HH:mm:ss', displayFormats: { minute: 'HH:mm' } },
                title: { display: true, text: '時間', color: '#ccc' },
                grid: { color: '#555' }, ticks: { color: '#ccc' },
            },
            y: {
                beginAtZero: true,
                title: { display: true, text: 'PM2.5 (µg/m³)', color: '#ccc' },
                grid: { color: '#555' }, ticks: { color: '#ccc' },
            },
        },
        animation: { duration: 250 }, // 可以稍微快一點的動畫
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#ccc' } },
            tooltip: {
                callbacks: {
                    labelColor: function(context) {
                        const pointIndex = context.dataIndex;
                        const dataset = context.dataset;
                        let pointColor = '#888'; // 默認顏色
                        if (Array.isArray(dataset.pointBackgroundColor) && dataset.pointBackgroundColor[pointIndex]) {
                            pointColor = dataset.pointBackgroundColor[pointIndex];
                        } else if (typeof dataset.pointBackgroundColor === 'string') {
                            pointColor = dataset.pointBackgroundColor;
                        }
                        return { borderColor: pointColor, backgroundColor: pointColor };
                    }
                }
            }
        }
    };

    const isActuallyConnected = connectionStatus.startsWith("已連接到") && connectedPortName !== '';

    return (
        <div id="App">
            <div className="container">
                {/* Sidebar */}
                <div className="sidebar">
                    <img src={mascotImage} alt="Mascot" className="mascot-image" />
                    <div className="mascot-bubble">{mascotMessage}</div>
                    <div className="controls">
                        <select value={selectedPort} onChange={e => setSelectedPort(e.target.value)} disabled={isConnecting || isActuallyConnected}>
                            <option value="">選擇序列埠</option>
                            {(ports || []).map(port => (<option key={port} value={port}>{port}</option>))}
                        </select>
                        {isActuallyConnected ? (
                            <button onClick={handleDisconnect} disabled={isConnecting}>
                                {isConnecting && !connectionStatus.startsWith("已連接到") ? "操作中..." : `從 ${connectedPortName} 斷開`}
                            </button>
                        ) : (
                            <button onClick={handleConnect} disabled={!selectedPort || isConnecting}>
                                {isConnecting ? "連接中..." : "連接"}
                            </button>
                        )}
                        <p>狀態: {connectionStatus}</p>
                        <div className="sound-toggle">
                            <label htmlFor="sound-toggle-checkbox">語音提示:</label>
                            <input type="checkbox" id="sound-toggle-checkbox" checked={isSoundOn} onChange={handleToggleSound} />
                            <span>{isSoundOn ? "開" : "關"}</span>
                        </div>
                    </div>
                </div>

                {/* Main Content */}
                <div className="main-content">
                    {isActuallyConnected ? (
                        <>
                            <div className="current-pm25">
                                <h2>目前 PM2.5 濃度</h2>
                                <p className="pm25-value" style={{ color: aqiInfo?.color || '#fff' }}>
                                    {typeof currentPM25 === 'number' ? currentPM25.toFixed(2) : 'N/A'} µg/m³
                                </p>
                                <p className="aqi-level" style={{ color: aqiInfo?.color || '#fff' }}>
                                    AQI 等級: {aqiInfo?.level || 'N/A'}
                                </p>
                            </div>
                            <div className="chart-container">
                                <h3>一小時内 PM2.5 變化</h3>
                                {(Array.isArray(downsampledChartHistory) && downsampledChartHistory.length > 1) ? (
                                    <Line options={chartOptions} data={chartData} />
                                ) : (
                                    <p style={{ textAlign: 'center', marginTop: '50px' }}>
                                        {connectedPortName ? '正在收集數據 (每5分鐘一點)...' : '請選擇序列埠並連接。'}
                                    </p>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="placeholder-text">
                            <p>{connectionStatus === '未連接' && !selectedPort ? '請選擇序列埠並連接以開始監測。' :
                                connectionStatus.includes('錯誤') || connectionStatus.includes('斷開') ? '請嘗試重新連接或選擇其他序列埠。' :
                                '等待連接...'}</p>
                        </div>
                    )}
                </div>
            </div>
            <audio ref={audioRef} style={{ display: 'none' }} />
        </div>
    );
}

export default App;