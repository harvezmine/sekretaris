import { config } from "../config.js";
import type { Button } from "../wa/client.js";
import { directAttachments } from "../uploads/links.js";
import { formatDate, formatIdr } from "../util.js";

export const BTN = {
  code: { id: "code", title: "Punya Kode" },
  price: { id: "price", title: "Lihat Harga" },
  faq: { id: "faq", title: "Tanya Dulu" },
  subscribe: { id: "subscribe", title: "Langganan" },
  executive: { id: "executive", title: "Eksekutif" },
  resendQr: { id: "resend_qr", title: "Kirim Ulang QR" },
  cancelPay: { id: "cancel_pay", title: "Batal" },
  deleteYes: { id: "delete_yes", title: "Ya, hapus semua" },
  deleteNo: { id: "delete_no", title: "Batal" },
} satisfies Record<string, Button>;

export const MENU_NEW: Button[] = [BTN.code, BTN.price, BTN.faq];
export const MENU_RETURNING: Button[] = [BTN.subscribe, BTN.code, BTN.faq];
export const MENU_PRICING: Button[] = [BTN.subscribe, BTN.executive, BTN.code];

/** Sent with reply buttons, so it must stay within WhatsApp's 1024-character limit. */
export function welcome(name: string | null): string {
  const hello = name ? `Halo ${name} 👋` : "Halo 👋";
  return [
    `${hello} Saya *Milo*, asisten pribadi Anda di WhatsApp. Cukup chat seperti ke sekretaris, saya yang urus.`,
    "",
    "📅 *Agenda & pengingat*: \"ingetin besok jam 9 telepon Pak Andi\", plus ringkasan agenda tiap pagi",
    `📄 *Dokumen & foto*: ${directAttachments() ? "kirim" : "unggah"} PDF atau foto, lalu tanya isinya`,
    "✉️ *Pesan ke orang lain*: saya susunkan dengan rapi",
    "🧠 *Ingat hal penting*: klien, preferensi, kebiasaan Anda",
    ...(config.GOOGLE_CLIENT_ID ? ["🔗 *Google*: kalender, Gmail, dan Drive Anda"] : []),
    "🎭 *Asisten sesuai selera*: nama dan kepribadian pilihan Anda, dari formal sampai gaya anime",
    ...(config.SERVER_ACCESS === "all" ? ["🖥️ *Cek server*: kondisi server dan error aplikasi"] : []),
    "",
    `${directAttachments() ? "Ketik atau kirim pesan suara" : "Ketik saja permintaan Anda"} kapan saja. Ketik *MENU* untuk pilihan cepat.`,
    "",
    "_Dengan melanjutkan, Anda setuju Milo menyimpan nomor dan percakapan ini. Ketik HAPUS kapan saja untuk menghapus data Anda._",
  ].join("\n");
}

export function pricing(): string {
  return [
    "*Harga Milo*",
    "",
    `*Coba Dulu* — gratis ${config.TRIAL_DAYS} hari, masuk dengan kode undangan.`,
    "",
    `*Profesional* — ${formatIdr(config.PRICE_PROFESIONAL_IDR)}/bulan`,
    "Percakapan intensif, simpan & tanya dokumen, pesan suara, pengingat.",
    "_Integrasi email & kalender menyusul tanpa biaya tambahan._",
    "",
    "*Eksekutif* — Rp1.000.000/bulan",
    "Percakapan tanpa batas 24/7, Milo menyapa duluan, dan tim kami yang memasangkan semuanya. Pilih *Eksekutif* untuk dihubungi.",
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
  "Lewat QRIS, dari m-banking atau e-wallet apa pun. Tidak ada potongan otomatis — Anda memperpanjang sendiri.",
  "",
  "*Bagaimana cara mencoba?*",
  `Masukkan kode undangan untuk mencoba gratis ${config.TRIAL_DAYS} hari.`,
].join("\n");

export const TEXT = {
  menuPrompt: "Untuk mulai, pilih salah satu di bawah ini.",
  afterInfo: "Mau lanjut ke mana?",
  codePrompt: "Silakan ketik kode undangan Anda.",
  codeInvalid: "Kode itu tidak dikenali, sudah kedaluwarsa, atau sudah terpakai. Coba ketik lagi, atau pilih di bawah.",
  codeGiveUp: "Kodenya belum cocok. Kalau belum punya kode, Anda tetap bisa berlangganan langsung.",
  trialUsed: "Masa coba untuk nomor ini sudah pernah dipakai. Anda bisa langsung berlangganan untuk lanjut.",
  executiveLead: "Terima kasih. Tim kami akan menghubungi Anda lewat WhatsApp ini dalam 1×24 jam untuk menyiapkan paket *Eksekutif*.",
  awaitingPayment: "Kami masih menunggu pembayaran Anda. Scan QR di atas, atau pilih di bawah.",
  paymentCancelled: "Pembayaran dibatalkan.",
  optedOut: "Baik, Milo tidak akan mengirim pesan lagi. Ketik MULAI kapan saja untuk kembali.",
  deleteConfirm:
    "Hapus *semua* data Anda dari Milo — percakapan, dokumen, catatan, kontak, dan pengingat? Ini tidak bisa dibatalkan.\n\nCatatan transaksi pembayaran tetap kami simpan karena diwajibkan aturan pajak, tanpa tautan ke percakapan Anda.",
  deleteCancelled: "Oke, tidak jadi dihapus.",
  deleted: "Semua data Anda sudah dihapus. Terima kasih sudah mencoba Milo.",
  voiceDisabled: "Pesan suara belum aktif di versi ini — silakan ketik pesannya dulu.",
  unsupported: "Jenis pesan ini belum bisa saya proses.",
  relayUnavailable: "Konfirmasi itu sudah tidak berlaku. Minta saya menyusun pesannya lagi kalau masih perlu.",
  relayAlreadySent: "Pesan itu sudah terkirim sebelumnya.",
  failure: "Maaf, ada gangguan di sisi kami. Coba kirim lagi sebentar lagi.",
  working: "Sebentar ya, masih saya kerjakan… ⏳",
  softMode:
    "Periode ini pemakaian Anda sudah cukup padat, jadi untuk sementara jawaban saya lebih ringkas. Pemakaian normal kembali di periode berikutnya.",
};

export function relayConfirm(who: string, minutes: number): string {
  return `Kirim pesan di atas ke ${who}? Konfirmasi berlaku ${minutes} menit.`;
}

export function relaySent(name: string): string {
  return `✅ Terkirim ke *${name}*. Kalau dibalas, balasannya saya teruskan ke sini.`;
}

export function relayCancelled(name: string): string {
  return `Oke, pesan ke *${name}* tidak jadi dikirim.`;
}

export function relayFailed(name: string, error: string): string {
  return `❌ Pesan ke *${name}* gagal terkirim (${error}). Coba lagi sebentar lagi, atau minta saya membuat link agar Anda kirim sendiri.`;
}

export function relayReply(name: string, waId: string, body: string): string {
  return `💬 *Balasan dari ${name}* (${waId}):\n${body}`;
}

export function relayAck(assistantName: string, ownerName: string): string {
  return `Terima kasih, pesan Anda sudah saya teruskan ke ${ownerName}. — ${assistantName}`;
}

export function uploadLink(url: string | undefined, hours: number): string {
  if (!url) return "Maaf, link untuk mengirim file sedang tidak tersedia. Coba lagi sebentar lagi.";
  return [
    "📎 *Kirim file lewat link ini:*",
    url,
    "",
    `PDF, Word, teks, foto, atau rekaman suara. Bisa sekaligus menulis pertanyaannya. Link ini pribadi dan berlaku ${hours} jam — jangan dibagikan.`,
  ].join("\n");
}

export function attachmentMissing(url: string | undefined): string {
  return [
    "Sepertinya Anda mengirim file, tapi filenya tidak sampai ke saya lewat WhatsApp.",
    url ? `Silakan kirim lewat link ini:\n${url}` : "Ketik *FILE* untuk mendapatkan link pengiriman file.",
  ].join("\n\n");
}

export function trialStarted(days: number, endsAt: Date, timeZone: string): string {
  return `✅ Masa coba *${days} hari* aktif sampai *${formatDate(endsAt, timeZone)}*.`;
}

export function paidActivated(planLabel: string, until: Date, timeZone: string): string {
  return `✅ Pembayaran diterima. *${planLabel}* aktif sampai *${formatDate(until, timeZone)}*.`;
}

// ---- getting to know the user -----------------------------------------------------------------------------------------

export const SETUP = {
  intro: (total: number) =>
    `Supaya bantuan saya pas untuk Anda, kita kenalan dulu, ya: *${total} pertanyaan singkat*. Setiap pertanyaan bisa dilewati (ketik *lewati*), dan semuanya bisa diubah nanti.`,
  callName: (hasName: boolean, total: number) =>
    `*1/${total}* · Mau saya panggil apa?\nContoh: _Pak Josh_, _Bu Rina_, _Kak Dimas_, atau _Bos_.${hasName ? "" : " Ketik saja panggilannya."}`,
  work: (total: number) =>
    `*2/${total}* · Apa usaha atau pekerjaan Anda?\nContoh: _punya 3 cabang kedai kopi_, _direktur kontraktor_, _dokter gigi_. Ini membantu saya memahami konteks permintaan Anda.`,
  personaIntro: (total: number) =>
    `*3/${total}* · Pilih kepribadian asisten Anda. Balas dengan *angka*, atau *lewati* untuk gaya standar.`,
  assistantName: (suggested: string | undefined) =>
    `Mau kasih saya nama?${suggested ? ` Nama yang cocok untuk gaya ini: *${suggested}*.` : ""} Ketik nama pilihan Anda, atau pilih di bawah.`,
  answerStyle: (total: number) => `*4/${total}* · Suka jawaban seperti apa?`,
  briefing: (total: number) =>
    `*5/${total}* · Mau saya kirimi *ringkasan agenda setiap pagi*?\nPilih di bawah, atau ketik jam lain, misalnya _06.30_.`,
  connect: (total: number) =>
    `*${total}/${total}* · Hubungkan akun supaya saya bisa membaca jadwal, email, dan dokumen Anda. Pilih di bawah, atau ketik *lewati*.`,
  retryCallName: "Panggilan itu terlalu panjang atau berisi simbol. Coba yang singkat, misalnya _Pak Josh_, atau ketik *lewati*.",
  retryWork: "Tolong ceritakan singkat saja (maksimal 200 huruf), atau ketik *lewati*.",
  retryPersona: "Balas dengan angka 1–14, atau ketik *lewati*.",
  retryAssistantName: "Nama itu belum bisa dipakai. Pakai huruf dan angka saja (maks. 30), atau pilih di bawah.",
  retryBriefing: "Jam itu belum saya pahami. Ketik misalnya _07.00_, atau pilih di bawah.",
  paused: "Oke, perkenalannya saya jeda dulu. Lanjutkan kapan saja lewat *MENU* → Profil.",
};

export const SETUP_BTN = {
  skip: { id: "setup:skip", title: "Lewati" },
  callBos: { id: "setup:call:bos", title: "Bos" },
  keepMilo: { id: "setup:name:keep", title: "Tetap Milo" },
  styleShort: { id: "setup:style:singkat", title: "Singkat & padat" },
  styleLong: { id: "setup:style:lengkap", title: "Lengkap & detail" },
  briefing7: { id: "setup:brief:07:00", title: "Ya, jam 07.00" },
  briefing8: { id: "setup:brief:08:00", title: "Ya, jam 08.00" },
  briefingOff: { id: "setup:brief:off", title: "Tidak usah" },
  restart: { id: "setup:restart", title: "Atur ulang profil" },
} satisfies Record<string, Button>;

export function setupDone(lines: string[]): string {
  return ["🎉 Beres, kita sudah kenalan! Ini yang saya catat:", ...lines, "", "Ubah kapan saja lewat *MENU* → Profil, atau cukup bilang ke saya."].join("\n");
}

// ---- quick actions ------------------------------------------------------------------------------------------------------

export function quickMenuIntro(assistantName: string, who: string | undefined): string {
  return `Hai${who ? ` ${who}` : ""}, ada yang bisa ${assistantName} bantu? Pilih di bawah, atau langsung ketik/ucapkan permintaan Anda.`;
}

// ---- connected accounts ---------------------------------------------------------------------------------------------

export function connectLink(url: string | undefined, labels: string[], minutes: number): string {
  if (!url) return "Maaf, link untuk menghubungkan Google belum bisa dibuat. Coba lagi sebentar lagi.";
  return [
    `🔗 *Hubungkan ${labels.join(", ")}*`,
    url,
    "",
    `Buka link ini, pilih akun Google Anda, dan centang semua izin yang diminta. Link pribadi, berlaku ${minutes} menit. Saya kabari di sini begitu tersambung.`,
  ].join("\n");
}

export function googleConnected(email: string | null, granted: string[], missing: string[], examples: string[]): string {
  return [
    `✅ Google terhubung${email ? ` (${email})` : ""}: ${granted.length ? granted.join(", ") : "belum ada layanan"}.`,
    ...(missing.length ? [`⚠️ ${missing.join(", ")} belum diizinkan. Ketik *KONEKSI* dan centang semua izin saat login.`] : []),
    ...(examples.length ? ["", "Coba minta, misalnya:", ...examples.map((e) => `• _${e}_`)] : []),
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
  actionUnavailable: "Konfirmasi itu sudah tidak berlaku. Minta saya menyiapkannya lagi kalau masih perlu.",
  actionDone: "Itu sudah dilakukan sebelumnya.",
};

export const QUICK_PROMPTS = {
  reminder: "⏰ Mau diingatkan apa, dan kapan?\nContoh: _ingetin besok jam 9 telepon Pak Andi_, atau _30 menit lagi angkat jemuran_.",
  message: "✉️ Mau kirim pesan ke siapa, dan isinya apa?\nContoh: _kabari Pak Andi 0812-xxxx, rapat jadi jam 3_. Bagikan kartu kontaknya kalau belum tersimpan.",
  server: "🖥️ Mau cek apa di server?\nContoh: _server saya aman?_, _ada error apa di aplikasi saya?_, atau _hubungkan server saya: user@alamat-ip port 22_.",
};

export function helpText(opts: { attachments: boolean; messaging: boolean; servers: boolean; google?: boolean }): string {
  return [
    "💡 *Contoh yang bisa Anda minta*",
    "",
    "*Agenda & pengingat*",
    "• _ingetin besok jam 9 rapat dengan vendor_",
    "• _agenda saya hari ini apa?_",
    "• _batalkan pengingat rapat vendor_",
    "",
    "*Dokumen & catatan*",
    opts.attachments ? "• kirim PDF/foto, lalu _poin pentingnya apa?_" : "• ketik *FILE*, unggah PDF/foto, lalu _poin pentingnya apa?_",
    "• _cari kontrak vendor B yang kemarin_",
    "• _catat: omzet cabang Kemang bulan ini 120 juta_",
    "",
    "*Orang & pesan*",
    "• bagikan kartu kontak, lalu _ini PM saya_",
    opts.messaging ? "• _kabari PM saya, laporan dikirim besok_ (saya kirim setelah Anda setujui)" : "• _buatkan pesan ke PM saya, laporan dikirim besok_",
    "",
    "*Tentang Anda*",
    "• _panggil saya Pak Josh_ · _jawab lebih singkat_",
    "• _ringkasan pagi jam 6_ · _ingat: saya tidak minum kopi_",
    ...(opts.servers ? ["", "*Server*", "• _server saya aman?_ · _cek error aplikasi saya_"] : []),
    "",
    ...(opts.google
      ? ["", "*Google*", "• _agenda minggu ini_ · _cari waktu kosong 1 jam besok_", "• _email penting hari ini apa?_ · _balas email Andi, bilang oke_", "• _cari proposal di Drive_ · _simpan file tadi ke Drive_"]
      : []),
    "",
    "Kata kunci: *MENU* pilihan cepat · *GAYA* ganti kepribadian · *FILE* kirim file · *KONEKSI* hubungkan akun · *HAPUS* hapus data · *STOP* berhenti",
  ].join("\n");
}

export function pendiriAccepted(): string {
  return `🎉 Kode *Harga Pendiri* diterima: *${formatIdr(config.PRICE_PENDIRI_IDR)}/bulan*, terkunci selama langganan Anda aktif.\n\nIni QR pembayarannya:`;
}

export function accessExpired(endedAt: Date | null, timeZone: string): string {
  const when = endedAt ? ` pada ${formatDate(endedAt, timeZone)}` : "";
  return `Masa aktif Milo Anda sudah berakhir${when}. Semua dokumen dan catatan Anda masih tersimpan — perpanjang untuk lanjut.`;
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
    "Mau lanjut tanpa jeda?",
  ].join("\n");
}
