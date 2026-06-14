# voicebridge — Devir / Handoff Notu

> Bu dosyayı yeni Claude Code oturumunun **ilk mesajına yapıştır** (ya da repoda
> dururken "HANDOFF.md'yi oku ve devam et" de). Amaç: yeni oturumdaki Claude,
> önceki oturumun tüm bağlamıyla kaldığı yerden devam etsin.

---

## 1. Proje nedir

**voicebridge** — telefondan (ve artık native uygulamalardan), **çift yönlü
sesle** kodlama ajanlarını (Claude Code, Codex, Antigravity, Ollama) kullanmayı
sağlayan bedava/açık kaynak köprü. Sen konuşursun, ajan senin makinende çalışır,
cevabı **sesli** geri okunur. ElevenLabs yok, dakika limiti yok.

- STT/TTS **telefon tarayıcısında** (Web Speech) ya da **native** (Flutter) çalışır.
- Küçük, **sıfır bağımlılık** Node köprüsü ajan CLI'ını headless çağırır ve cevabı **stream** eder.
- Telefona **Tailscale HTTPS** ile ulaşılır; opsiyonel **erişim token'ı** vardır.

**Repo:** https://github.com/berkayturanci/speak-with-claude-code
**Lisans:** MIT · **Sahip:** berkayturanci · **Sürüm:** 0.4.0

---

## 2. Şu anki durum (TAMAMLANDI ve test edildi)

Dosya yapısı:
```
speak-with-claude-code/
├── server.js              # zero-dep Node köprü (HTTP + ajan adapter'ları + stream + STT + auth)
├── public/                # web arayüzü (PWA): index.html, sw.js, manifest, icon
├── app/                   # native Flutter istemcisi (iOS/Android/macOS/Windows/Linux)
├── desktop/               # Electron masaüstü app (Mac .dmg / Windows / Linux) — köprüyü çalıştırır
├── examples/cloud-runner/ # referans cloud runner (uzak host'ta ajan)
├── docs/                  # architecture / configuration / security
├── test/                  # node:test suite (69 test) + smoke
├── README.md · CHANGELOG.md · LICENSE (MIT)
```

Çalışan özellikler (köprü tarafı testlerle, web tarafı DOM-shim testleriyle doğrulandı):
- ✅ **Çoklu ajan**: Claude Code, Codex, Antigravity, **Ollama** (HTTP API) — adapter katmanı
- ✅ **Çoklu oturum**: paralel sohbetler, oturum listesi ana ekran, yeniden adlandır/sil, geçmiş kalıcı
- ✅ **Talking modu**: sürekli sesli konuşma (sessizlikte otomatik gönder → sesli cevap → tekrar dinle), **ayarlanabilir sessizlik + dokun-kes barge-in**
- ✅ **Yaz ya da konuş**: streaming cevap, **tam markdown** (başlık/liste/link) + **diff renklendirme** + kod kopyala + katlanır uzun çıktı
- ✅ **Komut paleti** (`.claude/commands` + npm scripts), **klasör gezgini** (yerel + cloud uzak host)
- ✅ **Login**: `ACCESS_TOKEN` ayarlıysa gerçek doğrulamalı giriş ekranı (web + native)
- ✅ **Bildirimler**: Web Push (VAPID) / sayfa-içi; arka planda biten veya soru soran turda uyarır
- ✅ **Yerel Whisper STT** (opsiyonel, `STT_MODE=whisper`): ses üçüncü tarafa gitmez
- ✅ **Native Flutter app** (`app/`): oturum listesi, streaming, talking modu, geçmiş, palet, gözat
- ✅ **Electron masaüstü app** (`desktop/`): kontrol paneli (başlat/durdur, port/token, QR, canlı log) + agent/oturum panosu + tray
- ✅ **PWA**: manifest + service worker; **cloud runner** ile uzak host'ta çalıştırma

Env: `PORT` (8787), `HOST` (127.0.0.1), `DEFAULT_PROJECT_DIR`, `*_BIN`,
`ACCESS_TOKEN`, `STT_MODE`, `STT_CMD`, `CLOUD_RUNNER_URL`/`_TOKEN`, `OLLAMA_URL`,
`MAX_SESSIONS`, `MAX_INFLIGHT`, VAPID anahtarları, `FAVORITES`, `SESSIONS_FILE`.

API (tam liste için `docs/architecture.md`): `GET /api/health|config|sessions|browse|commands|ollama/models`,
`POST /api/ask` (NDJSON stream) `|sessions|reset|stt|push/subscribe`, `DELETE /api/sessions/:id`.

---

## 3. Mimari (iki parça)

```
İSTEMCİ (bağlanılan)                    HOST (ajanın çalıştığı makine)
  PWA (her tarayıcı)        ──┐
  Flutter app (iOS/Android) ──┼─ (Tailscale HTTPS + token) ─→  Node köprü (server.js)
  Flutter desktop (mac/win) ──┤                                  → ajan CLI / Ollama HTTP
  web                       ──┘                                  → NDJSON stream geri
                                          Electron app = köprüyü GUI ile çalıştırır
```

Bilinmesi gerekenler (dürüst sınırlar):
- Ajan **modeli** yine sağlayıcının bulutunda; biz **ses aracısını ve limitini** kaldırdık.
- iOS'ta **kurulu PWA mikrofona erişemez** → Safari **sekmesi**; ya da **native app** (native mic) kullan.
- Web Speech **STT** sesi tarayıcı sağlayıcısına yollar (bedava). Tam yerel → `STT_MODE=whisper`.
- Web Speech için **HTTPS şart** → `tailscale serve --bg 8787`.
- **Electron/Flutter bu repo CI'ında derlenmez** (toolchain yok). Kod köprü
  sözleşmesine yazıldı, `node --check` + DOM-shim testleri + köprü env doğrulamasından
  geçti. Gerçek `.dmg`/`.ipa`/`.apk` için kendi Mac/Xcode + Flutter/Electron ortamın gerekir.

---

## 4. Kalan adımlar / fikirler (roadmap)

İlk roadmap'in tamamı bitti (Dur butonu, QR, çoklu oturum, PWA, …). Açık fikirler:
- [ ] Flutter sohbetinde **markdown/diff** render (şu an düz metin)
- [ ] Talking modunda **gerçek barge-in** (TTS çalarken dinleme; yankı yönetimi gerekli)
- [ ] Gerçek **store/installer build'leri** (Mac'te `flutter build` / `electron-builder`)
- [ ] Tam-yerel STT'yi **WebSocket streaming** ile (whisper.cpp canlı)
- [ ] Çoklu kullanıcı / kalıcı kimlik (şu an tek token tabanlı)

## 5. Çalıştırma

```bash
# Köprü (host makine):
PORT=8787 npm start            # http://127.0.0.1:8787  (QR basar)
tailscale serve --bg 8787      # telefon için HTTPS

# Testler:
npm test                       # 69 test
npm run smoke                  # uçtan uca duman testi

# Native app (Mac/Flutter ortamı):  cd app && flutter create . && flutter run
# Masaüstü app:                     cd desktop && npm install && npm start
```

## 6. Önceki oturumlarda netleşen kararlar
- Hedef: **min maliyet + min efor + çalışsın** → ElevenLabs'e bağımlı olma.
- Köprü **sıfır bağımlılık** kalsın; istemciler (Flutter/Electron) ayrı klasörlerde kendi bağımlılıklarıyla.
- Kod gizliliği → Tailscale ile **üçüncü taraf relay yok**, opsiyonel token + login.
- PWA **sıfır-kurulum** seçeneği kalsın; native app **güvenilir ses** için yol.
- Geliştirme akışı: değişiklikleri **ayrı dalda** yap, **PR aç ve merge et**, testler yeşil kalsın.
