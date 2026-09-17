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

export function welcome(name: string | null): string {
  const hello = name ? `Halo ${name} 👋` : "Halo 👋";
  return [
    `${hello} Saya *Milo*, asisten pribadi Anda di WhatsApp.`,
    "",
    "Yang bisa saya kerjakan:",
    "• Menyimpan dokumen, foto, dan pesan suara — lalu menjawab isinya",
    "• Mengingatkan janji dan tenggat",
    "• Menyusun pesan untuk orang lain",
    "• Mengingat hal-hal penting tentang Anda",
    ...(config.SERVER_ACCESS === "all" ? ["• Mengecek kondisi server dan log aplikasi Anda"] : []),
    "• Nama dan gaya bicara saya bisa Anda atur sendiri",
    "",
    "Kirim apa saja ke sini, saya yang urus sisanya.",
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
  "Belum di versi ini. Sementara itu, teruskan email atau kirim dokumennya ke sini.",
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
  return [
    `✅ Masa coba *${days} hari* aktif sampai *${formatDate(endsAt, timeZone)}*.`,
    "",
    "Silakan langsung coba, misalnya:",
    directAttachments()
      ? "• Kirim PDF, lalu tanya \"poin pentingnya apa?\""
      : "• Ketik *FILE* untuk mengirim PDF atau foto, lalu tanya \"poin pentingnya apa?\"",
    "• \"Ingetin saya besok jam 9 telepon Pak Andi\"",
    ...(directAttachments() ? ["• Kirim pesan suara sambil jalan"] : []),
    "• Bagikan kartu kontak, lalu \"ini PM saya\"",
    "• Ketik *GAYA* untuk memberi saya nama dan kepribadian pilihan Anda",
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
