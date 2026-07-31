import { createApp } from 'vue';

import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');

// Service Worker 不在這裡自動註冊：離線快取是唯一會寫入裝置的東西，
// 交由 App.vue 裡的按鈕讓使用者自己決定要不要開。
