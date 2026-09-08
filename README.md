# Panduan Lengkap — Install & Jalankan DevOps Message Platform di Debian

Panduan ini dari nol: server Debian bersih → sampai aplikasi bisa diakses browser.
Semua langkah **manual** (tidak ada instalasi otomatis di dalam Docker build), sesuai permintaan.

---
## 0. Yang perlu disiapkan
- Server Debian (fisik/VPS) dengan akses `sudo` atau `root`
- File `devops-project-FIXED.zip` (hasil perbaikan) sudah ada di server, atau di-transfer via `scp`/`sftp`
---

## 1. Update sistem & install tools dasar
```bash
sudo apt update
sudo apt install -y curl git unzip
```
---
## 2. Install Docker & Docker Compose

```bash
curl -fsSL https://get.docker.com | sh
```
Cek berhasil:
```bash
docker version
docker compose version
docker run --rm hello-world
```
Kalau muncul `Hello from Docker!` → Docker sudah siap.

> Kalau user Anda bukan `root` dan mau jalankan `docker` tanpa `sudo`, tambahkan ke grup docker:
> ```bash
> sudo usermod -aG docker $USER
> newgrp docker
> ```

---
## 3. Install Node.js & npm di HOST (bukan di dalam container)

Ini wajib karena `backend/Dockerfile` pakai `COPY node_modules ./node_modules` — artinya folder `node_modules` harus **sudah ada di source** sebelum `docker build` dijalankan, bukan di-install otomatis oleh Docker.

Install Node.js 22 LTS via NodeSource (disesuaikan dengan `FROM node:22-alpine` di Dockerfile):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```
Cek versi:
```bash
node -v      # harus muncul v22.x.x
npm -v
```
---
## 4. Extract project
```bash
mkdir -p ~/devops-project
cd ~/devops-project
unzip /path/ke/devops-project-FIXED.zip -d .
ls
```
Pastikan terlihat folder `backend/`, `frontend-user/`, `frontend-admin/`, `nginx/`, `grafana/`, `prometheus/`, file `docker-compose.yml`, `.env`.

---
## 5. Install dependency backend secara MANUAL

Ini langkah kunci yang menggantikan `RUN npm install` di dalam Dockerfile:

```bash
cd ~/devops-project/backend
npm install --omit=dev
cd ~/devops-project
```
Setelah ini, pastikan folder `backend/node_modules` sudah terbentuk:
```bash
ls backend/node_modules | head
```
Kalau isinya banyak folder (express, pg, socket.io, dll) → berarti sudah benar, lanjut ke langkah berikutnya. Baru setelah ini `docker build` akan berhasil, karena `COPY node_modules ./node_modules` di Dockerfile butuh folder ini sudah ada.

---
## 6. Cek & sesuaikan file `.env`

File `.env` di root project sudah saya siapkan dengan nilai default (sinkron antara backend & database). Cek isinya:

```bash
cat .env
```

Isi defaultnya:
```
NODE_ENV=production
PORT=5000
POSTGRES_DB=devops_message
POSTGRES_USER=devops
POSTGRES_PASSWORD=devops_secure_password_2026
DATABASE_HOST=postgres
DATABASE_PORT=5432
REDIS_HOST=redis
REDIS_PORT=6379
JWT_SECRET=super_secret_jwt_key_devops_2026_change_me
ADMIN_USERNAME=admin
ADMIN_EMAIL=adminops123@gmail.com
ADMIN_PASSWORD=admindevops
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=adminops
```

> 🔐 **Disarankan** (opsional, tidak wajib untuk sekadar jalan): ganti `JWT_SECRET`, `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` dengan nilai unik kalau server ini akan dipakai serius/production. Kalau cuma testing internal, boleh dibiarkan default.
>
> Edit dengan:
> ```bash
> nano .env
> ```

---

## 7. Build image Docker (manual, tanpa auto-install apapun di dalamnya)

```bash
cd ~/devops-project
docker compose build
```

Proses ini hanya meng-copy file (`node_modules` yang sudah Anda siapkan di langkah 5, source code, `nginx.conf`, dll) ke dalam image — **tidak ada proses `npm install` atau instalasi otomatis lain di dalam Docker**.

---
## 8. Jalankan semua container

```bash
docker compose up -d
```

Cek semua container statusnya `Up`:
```bash
docker compose ps
```

Harus ada 8 container: `devops_backend`, `devops_frontend_user`, `devops_frontend_admin`, `devops_postgres`, `devops_redis`, `devops_nginx`, `devops_prometheus`, `devops_grafana`.

---

## 9. Verifikasi backend berhasil konek database & admin ter-seed

```bash
docker compose logs -f backend
```

Tunggu sampai muncul log kira-kira seperti:
```
Database terkoneksi.
Tabel siap.
Seeded default admin account successfully.
Server berjalan di port 5000
```
Kalau muncul error koneksi database, tunggu beberapa detik (Postgres masih startup) — `docker compose` sudah diatur `healthcheck` supaya backend otomatis retry sampai Postgres siap. Tekan `Ctrl+C` untuk keluar dari log (container tetap jalan di background).

---

## 10. Buka aplikasi di browser

| Layanan | URL |
|---|---|
| Frontend User (register/login/chat) | `http://<IP-SERVER>:3000` |
| Frontend Admin | `http://<IP-SERVER>:3001` |
| Grafana (monitoring) | `http://<IP-SERVER>:3002` |
| Backend API langsung (debug saja) | `http://<IP-SERVER>:5000` |

Login admin default:
- Username/Email: `admin` / `adminops123@gmail.com`
- Password: `admindevops`

Login Grafana default:
- Username: `admin`
- Password: `adminops`

---

## 11. Tes fitur yang tadinya bermasalah

1. Buka `http://<IP-SERVER>:3000` → klik **Register** → isi data baru → submit. Harus sukses & langsung bisa lanjut ke halaman chat/dashboard.
2. Logout, coba **Login** pakai akun yang baru dibuat. Harus berhasil masuk.
3. Buka `http://<IP-SERVER>:3001` → login pakai akun admin default di atas.

Kalau ketiganya berhasil, berarti perbaikan sudah bekerja.

---

## 12. Perintah operasional sehari-hari

**Lihat log real-time:**
```bash
docker compose logs -f backend
docker compose logs -f nginx
```

**Restart satu service saja:**
```bash
docker compose restart backend
```

**Stop semua tapi data tetap ada:**
```bash
docker compose stop
```

**Start lagi:**
```bash
docker compose start
```

**Matikan total & hapus container (data Postgres di volume tetap aman):**
```bash
docker compose down
```

**Matikan total & hapus SEMUA termasuk data database (reset total):**
```bash
docker compose down -v
```

**Setelah ubah `server.js`, `index.html`, atau `nginx.conf` — rebuild ulang:**
```bash
docker compose up -d --build
```
> Kalau yang berubah cuma `package.json` (nambah dependency baru), ulangi dulu langkah 5 (`npm install` manual di `backend/`) sebelum `docker compose build`.

**Backup database** (script sudah disediakan project, dan sudah cocok dengan `.env` sekarang):
```bash
cd scripts
chmod +x backup.sh restore.sh
./backup.sh
```

**Restore database dari backup:**
```bash
./restore.sh backups/postgres_backup_XXXXXXXX.sql
```

---

## 13. Troubleshooting cepat

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| `docker build` gagal, error `node_modules: no such file or directory` | Lupa jalankan langkah 5 | `cd backend && npm install --omit=dev` dulu, baru build |
| Register/login masih 500 error | Postgres belum siap saat backend start pertama kali | `docker compose restart backend`, cek `docker compose logs backend` |
| Port 3000/3001/3002 "address already in use" | Ada service lain di server pakai port sama | Matikan service lain, atau ubah mapping port di `docker-compose.yml` |
| Tidak bisa akses dari luar (dari laptop ke server) | Firewall Debian (`ufw`) memblokir | `sudo ufw allow 3000,3001,3002,5000/tcp` |
| Setelah `npm install` versi Node beda dan ada error native binding | Versi Node host ≠ versi Node di image (`node:22-alpine`) | Pastikan `node -v` di host = 22.x seperti langkah 3 |

---

## Ringkasan alur singkat (kalau sudah familiar)
```bash
sudo apt update && sudo apt install -y curl git unzip
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

mkdir ~/devops-project && cd ~/devops-project
unzip /path/ke/devops-project-FIXED.zip -d .

cd backend && npm install --omit=dev && cd ..

docker compose build
docker compose up -d
docker compose logs -f backend
```






















### === UNTUK INSTALL DOCKER LEWAT LINUX DEBIAN ===
LAKUKAN UPDATE
```
sudo apt update
sudo apt install git -y
sudo apt install curl -y
```
INSTALL DOCKER UBUNTU
```
curl -fsSL https://get.docker.com | sudo sh
```
INSTALL DOCKER DEBIAN
```
curl -fsSL https://get.docker.com | sh
```
TEST APAKAH BERHASIL
```
docker version
docker compose version
```
TEST DOCKER
`docker run --rm hello-world`
KALAU BERHASIL MUNCUL
`Hello from Docker!`




By Akhsanul and zorcaa
