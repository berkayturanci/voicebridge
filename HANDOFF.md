# voicebridge — Devir / Handoff Notu

> Bu dosyayı yeni Claude Code oturumunun **ilk mesajına yapıştır** (ya da repoya
> `HANDOFF.md` olarak koy ve "HANDOFF.md'yi oku ve devam et" de). Amaç: yeni
> oturumdaki Claude, önceki oturumun tüm bağlamıyla kaldığı yerden devam etsin.

---

## 1. Proje nedir

**voicebridge** — telefondan, **çift yönlü sesle** Claude Code kullanmayı sağlayan
bedava/açık kaynak köprü. Sen konuşursun, Claude Code (Mac'inde) çalışır, cevabı
**sesli** geri okunur. ElevenLabs yok, dakika limiti yok.

- Konuşma tanıma (STT) ve seslendirme (TTS) **telefon tarayıcısında** çalışır (Web Speech API).
- Küçük, **sıfır bağımlılık** Node köprüsü `claude` CLI'ı headless çağırır ve cevabı **stream** eder.
- Telefona **Tailscale HTTPS** ile ulaşılır; opsiyonel **erişim token'ı** vardır.

**Repo:** https://github.com/berkayturanci/speak-with-claude-code
**Lisans:** MIT · **Sahip:** berkayturanci

---

## 2. Şu anki durum (TAMAMLANDI ve test edildi)

Dosya yapısı:
```
speak-with-claude-code/
├── server.js            # zero-dep Node köprü (HTTP + claude headless + stream + STT + auth)
├── public/index.html    # tek dosya web arayüzü (mic, TTS, streaming, dil, eller-serbest)
├── package.json
├── README.md
├── LICENSE              # MIT
└── .gitignore
```

Çalışan özellikler (hepsi offline stub'larla doğrulandı):
- ✅ **Web Speech STT/TTS** (Türkçe + İngilizce), eller-serbest döngü
- ✅ **Streaming cevap:** `claude --output-format stream-json` → NDJSON → tarayıcı
  **cümle cümle** seslendirir
- ✅ **Yerel Whisper STT** (opsiyonel): `STT_MODE=whisper` + `STT_CMD` → MediaRecorder
  → `/api/stt` → kendi Whisper komutun (ses Apple'a gitmez)
- ✅ **Token koruması:** `ACCESS_TOKEN` ayarlıysa `/api/*` için `Bearer` zorunlu (401 testleri geçti)

Env değişkenleri: `PORT` (8787), `HOST` (127.0.0.1), `PROJECT_DIR`, `CLAUDE_BIN`,
`ACCESS_TOKEN`, `STT_MODE` (browser|whisper), `STT_CMD`.

API: `GET /api/config` · `POST /api/ask` (stream) · `POST /api/stt` · `POST /api/reset`.

---

## 3. Mimari (ve dürüst sınırlar)

```
[iPhone Safari] mic → Web Speech STT → metin
   → (Tailscale HTTPS) → [Mac köprü] → claude -p --continue (stream-json)
   → speechSynthesis (Yelda) → telefon hoparlörü 🔊
```

Bilinmesi gerekenler:
- Claude **modeli** yine Anthropic bulutunda (Claude Code böyle çalışır); biz sadece
  **ses aracısını ve limitini** kaldırdık.
- iOS'ta **kurulu PWA mikrofona erişemez** → Safari **sekmesi** olarak açılmalı.
- Web Speech **STT** sesi Apple'a gönderir (bedava, yerel değil). Tam yerel istersen `STT_MODE=whisper`.
- Web Speech **TTS** tamamen cihazda (Türkçe Yelda dahil).
- Web Speech için **HTTPS şart** → `tailscale serve` gerçek sertifika verir.

---

## 4. Kalan adımlar / yapılacaklar

### A) Kodu repoya koymak
Eğer repo henüz boşsa, Mac'te:
```bash
tar -xzf voicebridge.tar.gz   # ya da mevcut voicebridge/ klasörü
cd voicebridge
git init && git add -A && git commit -m "voicebridge: voice for Claude Code"
git branch -M main
git remote add origin https://github.com/berkayturanci/speak-with-claude-code.git
git push -u origin main        # reddedilirse: git pull --rebase origin main && git push
```
> Yeni oturumdaki Claude, repo kapsamdaysa bunu **kendisi de pushlayabilir**
> (`push_files` ile). Ona "voicebridge dosyalarını bu repoya koy" demen yeter.

### B) Repoyu public yap (açık kaynak paylaşımı için)
GitHub → repo → Settings → General → Danger Zone → **Change visibility → Public**.

### C) Sıradaki özellik fikirleri (roadmap)
- [ ] Streaming sırasında **"Dur"** butonu (konuşmayı/talebi iptal)
- [ ] Telefonda **QR ile hızlı açma** (terminalde URL'yi QR olarak bas)
- [ ] README'ye **ekran görüntüsü / GIF**
- [ ] Tam-yerel STT'yi **WebSocket streaming** ile (whisper.cpp canlı)
- [ ] `--session-id` ile çoklu/izole oturum
- [ ] Basit bir **PWA manifest** + ikon (ama iOS mic için yine Safari sekmesi gerekir)

---

## 5. Yeni oturum için açılış komutu (kopyala-yapıştır)

> Yeni Claude Code oturumunu **`speak-with-claude-code`** reposuyla başlat, sonra:

```
Bu repo "voicebridge": telefondan çift yönlü sesle Claude Code kullanmayı sağlayan
bedava/açık kaynak bir köprü. HANDOFF.md'deki bağlamı esas al. Şu an istediğim:
1) (gerekiyorsa) voicebridge dosyalarını repoya pushla,
2) roadmap'teki "Dur butonu" ve "QR ile açma" özelliklerini ekle,
3) README'ye kısa bir kullanım GIF/ekran görüntüsü yer tut.
Değişiklikleri ayrı bir dalda yapıp PR aç.
```

---

## 6. Önceki oturumda netleşen kararlar
- Hedef: **min maliyet + min efor + çalışsın** → ElevenLabs'e bağımlı olma.
- STT yolu: **Apple (bedava, kolay)** seçildi; yerel Whisper opsiyonel bırakıldı.
- Repo: **ai-jury'den ayrı**, yeni repo (`speak-with-claude-code`).
- Kod gizliliği önemli → Tailscale ile **üçüncü taraf relay yok**, opsiyonel token var.
