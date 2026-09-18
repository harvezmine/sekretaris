import { config } from "../config.js";
import type { Button } from "../wa/client.js";
import { directAttachments } from "../uploads/links.js";
import { formatDate, formatIdr } from "../util.js";

/**
 * Each choice is named inside the question that offers it, so nothing is ever presented as option 1, 2 or 3. What is
 * listed here is only what counts as picking it when the answer comes back as ordinary words.
 */
export const BTN = {
  code: { id: "code", title: "Punya Kode", say: ["kode", "punya kode", "pakai kode", "kode undangan", "ada kode"] },
  price: { id: "price", title: "Lihat Harga", say: ["harga", "harganya", "lihat harga", "berapa", "biaya"] },
  faq: { id: "faq", title: "Tanya Dulu", say: ["tanya", "tanya dulu", "tanya-tanya", "nanya"] },
  subscribe: { id: "subscribe", title: "Langganan", say: ["langganan", "berlangganan", "daftar", "bayar", "lanjut langganan"] },
  executive: { id: "executive", title: "Eksekutif", say: ["eksekutif", "paket eksekutif"] },
  resendQr: { id: "resend_qr", title: "Kirim Ulang QR", say: ["qr", "kirim ulang", "ulang", "kirim ulang qr"], answer: "yes" },
  cancelPay: { id: "cancel_pay", title: "Batal", say: ["batalkan"], answer: "no" },
  deleteYes: { id: "delete_yes", title: "Ya, hapus semua", say: ["hapus", "hapus semua", "yakin"], answer: "yes" },
  deleteNo: { id: "delete_no", title: "Batal", say: ["batalkan", "jangan"], answer: "no" },
} satisfies Record<string, Button>;

export const MENU_NEW: Button[] = [BTN.code, BTN.price, BTN.faq];
export const MENU_RETURNING: Button[] = [BTN.subscribe, BTN.code, BTN.faq];
export const MENU_PRICING: Button[] = [BTN.subscribe, BTN.executive, BTN.code];

/** The same three ways in, put as a question instead of a list of options. */
export function menuPrompt(returning: boolean): string {
  return returning
    ? "Mau lanjut berlangganan, pakai kode undangan, atau ada yang mau ditanyakan dulu?"
    : "Punya kode undangan, mau lihat harganya dulu, atau ada yang mau ditanyakan?";
}

/** The first thing a stranger reads: who is writing, and what happens next. Nothing about features. */
export function welcome(name: string | null): string {
  return [
    `Halo${name ? ` ${name}` : ""} 👋 Saya Milo, sekretaris yang bekerja lewat WhatsApp.`,
    "Kalau sudah punya kode undangan, kirim saja ke sini. Kalau mau tanya-tanya dulu, silakan.",
    "",
    "_Ngobrol di sini berarti nomor dan isi percakapannya saya simpan. Ketik HAPUS kapan saja kalau mau saya hapus semuanya._",
  ].join("\n");
}

export function pricing(): string {
  return [
    "*Harga Milo*",
    "",
    `*Coba Dulu*: gratis ${config.TRIAL_DAYS} hari, masuk dengan kode undangan.`,
    "",
    `*Profesional*: ${formatIdr(config.PRICE_PROFESIONAL_IDR)}/bulan`,
    "Percakapan intensif, simpan & tanya dokumen, pesan suara, pengingat.",
    "_Integrasi email & kalender menyusul tanpa biaya tambahan._",
    "",
    "*Eksekutif*: Rp1.000.000/bulan",
    "Percakapan tanpa batas 24/7, Milo menyapa duluan, dan tim kami yang memasangkan semuanya. Kalau tertarik, bilang saja *Eksekutif*, nanti tim kami menghubungi Anda.",
    "",
    "Pembayaran lewat QRIS dari m-banking atau e-wallet apa pun. Tidak ada potongan otomatis.",
  ].join("\n");
}

export const FAQ = [
  "*Pertanyaan yang sering muncul*",
  "",
  "*Apa yang terjadi dengan data saya?*",
  "Pesan dan dokumen Anda disimpan di server Milo dan diproses oleh penyedia AI kami untuk menyusun jawaban. Kami tidak menjualnya atau memakainya untuk iklan. Ketik HAPUS kapan saja untuk menghapus semuanya.",
  "",
  "*Bisa membaca email dan kalender saya?*",
  config.GOOGLE_CLIENT_ID
    ? "Bisa, setelah Anda menghubungkan akun Google (ketik *KONEKSI*). Saya tidak pernah melihat password Anda, dan email atau undangan hanya terkirim setelah Anda setujui."
    : "Belum di versi ini. Sementara itu, teruskan email atau kirim dokumennya ke sini.",
  "",
  "*Bagaimana cara membayar?*",
  "Lewat QRIS, dari m-banking atau e-wallet apa pun. Tidak ada potongan otomatis, jadi Anda yang memperpanjang sendiri.",
  "",
  "*Bagaimana cara mencoba?*",
  `Masukkan kode undangan untuk mencoba gratis ${config.TRIAL_DAYS} hari.`,
].join("\n");

export const TEXT = {
  preboardFallback: "Kirim kode undangan Anda ke sini untuk mulai. Kalau belum punya, ketik *MENU* untuk lihat harga.",
  afterInfo: "Mau saya siapkan pembayarannya, tertarik yang Eksekutif, atau sudah punya kode undangan?",
  afterFaq: "Ada lagi yang mau ditanyakan? Kalau sudah punya kode undangan, kirim saja ke sini, atau saya tunjukkan harganya dulu.",
  codePrompt: "Boleh, ketik kodenya di sini.",
  codeInvalid: "Kodenya belum cocok. Mungkin salah ketik, sudah kedaluwarsa, atau sudah dipakai. Coba sekali lagi, atau mau lihat harganya dulu?",
  codeGiveUp: "Kodenya masih belum cocok. Kalau memang belum punya, Anda tetap bisa langsung berlangganan. Mau saya siapkan pembayarannya, atau lihat harganya dulu?",
  trialUsed: "Masa coba untuk nomor ini sudah pernah dipakai. Mau lanjut berlangganan, atau lihat harganya dulu?",
  executiveLead: "Terima kasih. Tim kami akan menghubungi Anda lewat WhatsApp ini dalam 1×24 jam untuk menyiapkan paket *Eksekutif*.",
  awaitingPayment: "Pembayarannya belum masuk. QR-nya masih yang di atas. Mau saya kirim ulang, atau dibatalkan saja?",
  paymentCancelled: "Oke, pembayarannya saya batalkan.",
  optedOut: "Baik, Milo tidak akan mengirim pesan lagi. Ketik MULAI kapan saja untuk kembali.",
  deleteConfirm:
    "Ini akan menghapus semua data Anda: percakapan, dokumen, catatan, kontak, dan pengingat. Tidak bisa dibatalkan setelahnya.\n\nCatatan transaksi pembayaran tetap kami simpan karena diwajibkan aturan pajak, tanpa tautan ke percakapan Anda.\n\nYakin mau dihapus semuanya?",
  deleteCancelled: "Oke, tidak jadi dihapus.",
  deleted: "Semua data Anda sudah dihapus. Terima kasih sudah mencoba Milo.",
  voiceDisabled: "Pesan suara belum bisa saya dengarkan. Boleh diketik saja?",
  unsupported: "Yang ini belum bisa saya buka. Boleh dikirim sebagai teks?",
  relayUnavailable: "Konfirmasinya sudah kedaluwarsa. Kalau masih perlu, bilang saja, saya susun ulang pesannya.",
  relayAlreadySent: "Yang itu sudah terkirim tadi.",
  failure: "Maaf, barusan ada gangguan di tempat saya. Boleh kirim ulang sebentar lagi?",
  working: "Sebentar ya, lagi saya kerjakan.",
  softMode:
    "Periode ini pemakaian Anda sudah cukup padat, jadi untuk sementara jawaban saya lebih ringkas. Pemakaian normal kembali di periode berikutnya.",
};

export function relayConfirm(who: string, minutes: number): string {
  return `Saya kirim ke ${who} sekarang? Kalau ada yang mau diubah, bilang saja. Saya tunggu ${minutes} menit.`;
}

export function relaySent(name: string): string {
  return `✅ Sudah terkirim ke *${name}*. Kalau dibalas, nanti saya teruskan ke sini.`;
}

export function relayCancelled(name: string): string {
  return `Oke, pesan ke *${name}* tidak jadi dikirim.`;
}

export function relayFailed(name: string, error: string): string {
  return `Maaf, pesan ke *${name}* belum berhasil terkirim (${error}). Mau saya coba lagi?`;
}

export function relayReply(name: string, waId: string, body: string): string {
  return `💬 *${name}* membalas (${waId}):\n${body}`;
}

export function relayAck(assistantName: string, ownerName: string): string {
  return [
    `Terima kasih, pesan Anda sudah saya sampaikan ke ${ownerName}. Balasan berikutnya juga saya teruskan ke beliau.`,
    `Kalau Anda ingin berbicara dengan saya soal layanan ini, ketik *MENU*.`,
    `Salam,\n${assistantName}`,
  ].join("\n\n");
}

export function uploadLink(url: string | undefined, hours: number): string {
  if (!url) return "Maaf, link untuk mengirim file sedang tidak tersedia. Coba lagi sebentar lagi.";
  return [
    "📎 *Kirim file lewat link ini:*",
    url,
    "",
    `PDF, Word, teks, foto, atau rekaman suara. Bisa sekaligus menulis pertanyaannya. Link ini pribadi dan berlaku ${hours} jam, jadi jangan dibagikan.`,
  ].join("\n");
}

/** LOKASI: the browser page, plus the two ways that need no link at all. */
export function locationLink(url: string | undefined, minutes: number): string {
  if (!url) return "Kirim lokasi lewat WhatsApp (📎 lalu Lokasi), atau tempel link Google Maps tempat Anda sekarang.";
  return [
    "📍 Buka link ini dan tekan *Kirim lokasi saya*:",
    url,
    "",
    `Bisa juga tempel link Google Maps, atau sebut saja tempatnya. Link ini pribadi, berlaku ${minutes} menit.`,
  ].join("\n");
}

/** A shared contact card that never arrived, or arrived as a file Milo cannot open. */
export const CONTACT_CARD_MISSING =
  "👤 Kartu kontaknya belum bisa saya baca di nomor ini. Ketik saja nama dan nomornya, misalnya _simpan kontak Andi 0812-3456-7890, dia PM saya_, langsung saya simpan.";

export function attachmentMissing(url: string | undefined): string {
  return [
    "📎 File, foto, kartu kontak, atau pesan suara yang dikirim langsung di WhatsApp belum bisa saya terima di nomor ini, termasuk keterangannya.",
    url
      ? `Kirim lewat link ini, dan tulis pertanyaannya (misalnya _tolong rangkum_) di kolom yang tersedia:\n${url}\n\n_Link pribadi, berlaku ${config.UPLOAD_LINK_HOURS} jam._`
      : "Ketik *FILE* untuk mendapatkan link pengiriman file.",
    "Kalau tadi kartu kontak: ketik nama dan nomornya di sini, saya simpan. Kalau tadi lokasi: ketik *LOKASI*, atau sebut saja Anda sedang di mana.",
  ].join("\n\n");
}

export function trialStarted(days: number, endsAt: Date, timeZone: string): string {
  return `Kodenya cocok. Mulai sekarang saya jadi sekretaris Anda, gratis *${days} hari*, sampai *${formatDate(endsAt, timeZone)}*.`;
}

export function paidActivated(planLabel: string, until: Date, timeZone: string): string {
  return `Pembayarannya sudah masuk, terima kasih. Langganan *${planLabel}* Anda aktif sampai *${formatDate(until, timeZone)}*.`;
}

// ---- getting to know the user -----------------------------------------------------------------------------------------

export const SETUP = {
  callName: (name: string | undefined) =>
    `Biar enak ngobrolnya, saya panggil Anda apa?${name ? ` ${name} saja, atau ada panggilan lain?` : ""}`,
  work: (callName: string | undefined) =>
    `Oke${callName ? `, ${callName}` : ""}. Sehari-hari Anda sibuk di bidang apa? Biar saya nyambung kalau nanti Anda cerita soal kerjaan.`,
  connect: (noted: boolean) =>
    `${noted ? "Siap, sudah saya catat. " : ""}Satu lagi. Kalau kalender dan email Anda ada di Google, saya bisa ikut mengurusnya: agenda, email yang masuk, dokumen, dan kontak. Mau saya sambungkan sekarang, atau nanti saja?`,
  retryCallName: "Boleh yang lebih singkat? Misalnya Pak Josh, atau Bos.",
  retryWork: "Satu kalimat saja cukup.",
  paused: "Oke, kenalannya kita lanjutkan nanti saja.",
};

export const SETUP_BTN = {
  restart: { id: "setup:restart", title: "Atur ulang profil", say: ["ulang", "atur ulang", "ulangi"], answer: "yes" },
} satisfies Record<string, Button>;

export function setupDone(callName: string | undefined): string {
  return [
    `Siap${callName ? `, ${callName}` : ""}. Tiap pagi saya kabari agenda hari itu, siang saya ingatkan istirahat sebentar, dan sore saya cek lagi untuk besok. Kalau ada yang tidak perlu, bilang saja.`,
    "",
    "Sekarang, mau mulai dari apa?",
  ].join("\n");
}

// ---- quick actions ------------------------------------------------------------------------------------------------------

export function quickMenuIntro(who: string | undefined): string {
  return `Hai${who ? ` ${who}` : ""}. Yang biasa saya bantu, sebut saja mana yang Anda perlukan:`;
}

// ---- connected accounts ---------------------------------------------------------------------------------------------

export function connectLink(url: string | undefined, labels: string[], minutes: number): string {
  if (!url) return "Maaf, link untuk menghubungkan Google belum bisa dibuat. Coba lagi sebentar lagi.";
  return [
    `🔗 *Hubungkan ${labels.join(", ")}*`,
    url,
    "",
    `Buka linknya, pilih akun Google Anda, lalu centang semua izin yang diminta. Link ini pribadi dan berlaku ${minutes} menit. Begitu tersambung, saya kabari di sini.`,
  ].join("\n");
}

export function googleConnected(email: string | null, granted: string[], missing: string[], examples: string[]): string {
  return [
    `Google Anda sudah tersambung${email ? ` (${email})` : ""}, untuk ${granted.length ? granted.join(", ") : "belum ada layanan"}.`,
    ...(missing.length ? [`⚠️ ${missing.join(", ")} belum diizinkan. Ketik *KONEKSI*, lalu centang semua izin saat login.`] : []),
    ...(examples.length ? ["", "Sekarang Anda bisa minta, misalnya:", ...examples.map((e) => `• _${e}_`)] : []),
  ].join("\n");
}

export function googleExpired(url: string): string {
  return `⚠️ Login Google Anda sudah kedaluwarsa, jadi saya belum bisa membaca kalender, email, atau Drive. Login ulang lewat link ini (berlaku 30 menit):\n${url}`;
}

export const CONNECT_TEXT = {
  disconnected: "Akun Google sudah diputus dan akses saya dicabut. Hubungkan lagi kapan saja lewat *KONEKSI*.",
  notConnected: "Akun Google belum terhubung.",
  server: "🖥️ Untuk menghubungkan server, kirim alamatnya, misalnya: _hubungkan server saya: user@alamat-ip port 22_. Saya balas dengan satu perintah untuk dipasang di server itu.",
  actionCancelled: "Oke, dibatalkan.",
  actionUnavailable: "Konfirmasinya sudah kedaluwarsa. Kalau masih perlu, bilang saja, saya siapkan lagi.",
  actionDone: "Yang itu sudah beres tadi.",
};

export const SERVER_TEXT = {
  noAccess: "Fitur server belum aktif untuk nomor ini.",
  actionsOff: "Menjalankan perintah di server belum diaktifkan di Milo ini.",
  queued: "Perintahnya siap, menunggu konfirmasi Anda.",
  help:
    "🖥️ *Perintah server*\n" +
    "• _aksi sigma deploy: cd /home/app && ./deploy.sh_ (simpan sekali, lalu cukup bilang \"deploy sigma\")\n" +
    "• _jalankan di sigma: docker compose restart app_ (sekali pakai)\n" +
    "• _aksi sigma_ lihat yang tersimpan · _hapus aksi sigma deploy_\n\n" +
    "_Perintahnya selalu Anda yang tulis, dan tidak ada yang jalan sebelum Anda menyetujuinya._",
};

export function actionSaved(server: string, name: string, command: string): string {
  return `✅ Aksi *${name}* tersimpan untuk *${server}*:\n\n\`\`\`\n${command}\n\`\`\`\n\nMulai sekarang cukup bilang: _${name} ${server}_.`;
}

export function actionForgotten(server: string, name: string): string {
  return `Aksi *${name}* di *${server}* dihapus.`;
}

export function actionUnknown(server: string, name: string): string {
  return `Tidak ada aksi *${name}* di *${server}*. Ketik *aksi ${server}* untuk melihat yang ada.`;
}

export function actionUnknownServer(server: string): string {
  return `Server *${server}* belum terhubung. Ketik *KONEKSI* untuk menambahkannya.`;
}

export function actionList(servers: { server: string; actions: { name: string; command: string; description: string }[] }[]): string {
  const withActions = servers.filter((s) => s.actions.length);
  if (!withActions.length) return `Belum ada aksi tersimpan.\n\n${SERVER_TEXT.help}`;
  return [
    "🖥️ *Aksi tersimpan*",
    ...withActions.flatMap((s) => [
      "",
      `*${s.server}*`,
      ...s.actions.map((a) => `• *${a.name}*: \`${a.command.length > 80 ? `${a.command.slice(0, 80)}…` : a.command}\``),
    ]),
  ].join("\n");
}

export const QUICK_PROMPTS = {
  reminder:
    "⏰ Mau diingatkan apa, dan kapan?\nContoh: _ingetin besok jam 9 telepon Pak Andi_, _30 menit lagi angkat jemuran_, atau _tiap tanggal 25 ingetin bayar gaji_.",
  message: "✉️ Mau kirim pesan ke siapa, dan isinya apa?\nContoh: _kabari Pak Andi 0812-xxxx, rapat jadi jam 3_. Bagikan kartu kontaknya kalau belum tersimpan.",
  server:
    "🖥️ Mau cek apa di server?\nContoh: _server saya aman?_, _ada error apa di aplikasi saya?_, atau _hubungkan server saya: user@alamat-ip port 22_.\n\n" +
    SERVER_TEXT.help,
};

export function helpText(opts: { attachments: boolean; servers: boolean; google?: boolean }): string {
  return [
    "💡 *Contoh yang bisa Anda minta*",
    "",
    "*Agenda & pengingat*",
    "• _ingetin besok jam 9 rapat dengan vendor_",
    "• _tiap Senin jam 8 ingetin setor laporan mingguan_",
    "• _agenda saya hari ini apa?_ · _batalkan pengingat rapat vendor_",
    "",
    "*Dokumen & catatan*",
    opts.attachments ? "• kirim PDF/foto, lalu _poin pentingnya apa?_" : "• ketik *FILE*, unggah PDF/foto, lalu _poin pentingnya apa?_",
    "• _cari kontrak vendor B yang kemarin_",
    "• _catat: omzet cabang Kemang bulan ini 120 juta_",
    "",
    "*Orang & pesan*",
    "• _kontak Andi berapa?_ (dari Google Kontak Anda) · _simpan Andi 0812-xxxx, dia PM saya_",
    "• _kabari PM saya, laporan dikirim besok_ (saya yang kirim, setelah Anda setujui)",
    "",
    "*Tentang Anda*",
    "• _panggil saya Pak Josh_ · _jawab lebih singkat_",
    "• _ringkasan pagi jam 6_ · _ingat: saya tidak minum kopi_",
    ...(opts.servers
      ? ["", "*Server*", "• _server saya aman?_ · _cek error aplikasi saya_", "• _aksi sigma deploy: ./deploy.sh_ lalu _deploy sigma_ (jalan setelah Anda setujui)"]
      : []),
    "",
    ...(opts.google
      ? [
          "",
          "*Google*",
          "• _agenda minggu ini_ · _cari waktu kosong 1 jam besok_",
          "• _email penting hari ini apa?_ · _balas email Andi, bilang oke_",
          "• _cari proposal di Drive_ · _simpan file tadi ke Drive_",
          "• _catat tugas: siapkan draft kontrak_ · _tugas saya apa saja?_",
          "• _buatkan form pesanan: nama, nomor HP, jumlah_ · _sudah berapa yang isi?_",
        ]
      : []),
    "",
    "Kata kunci: *MENU* pilihan cepat · *GAYA* ganti kepribadian · *FILE* kirim file · *KONEKSI* hubungkan akun · *LOKASI* kirim lokasi · *HAPUS* hapus data · *STOP* berhenti",
  ].join("\n");
}

export function pendiriAccepted(): string {
  return `🎉 Kode *Harga Pendiri* cocok, jadi untuk Anda *${formatIdr(config.PRICE_PENDIRI_IDR)}/bulan*, dan harganya terkunci selama langganan berjalan.\n\nIni QR pembayarannya:`;
}

export function accessExpired(endedAt: Date | null, timeZone: string): string {
  const when = endedAt ? ` pada ${formatDate(endedAt, timeZone)}` : "";
  return `Masa aktif langganan Anda sudah berakhir${when}. Dokumen dan catatan Anda masih tersimpan semua, tinggal diperpanjang untuk lanjut.`;
}

export function accountSummary(plan: string | null, until: Date | null, timeZone: string): string {
  const label = plan === "trial" ? "Masa coba" : plan === "pendiri" ? "Harga Pendiri" : plan === "profesional" ? "Profesional" : plan ?? "-";
  return `Paket Anda: *${label}*${until ? `, aktif sampai *${formatDate(until, timeZone)}*` : ""}.`;
}

export function trialNudge(stats: { endsAt: Date; files: number; reminders: number; answers: number }, timeZone: string): string {
  return [
    `Masa coba Milo Anda berakhir *${formatDate(stats.endsAt, timeZone)}*.`,
    "",
    "Sejauh ini Milo sudah:",
    `• menyimpan ${stats.files} file dan catatan`,
    `• mengingatkan Anda ${stats.reminders} kali`,
    `• menjawab ${stats.answers} permintaan`,
    "",
    "Mau lanjut berlangganan supaya tidak terputus, atau lihat harganya dulu?",
  ].join("\n");
}
