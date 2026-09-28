import { CalendarAuth } from '../channels/whatsapp-baileys/calendar-auth.ts'

const auth = new CalendarAuth(process.cwd())
try {
  await auth.connect(url => {
    process.stdout.write('Buka URL ini di browser untuk memberi izin Google Calendar:\n')
    process.stdout.write(`${url}\n`)
  })
  process.stdout.write('Google Calendar terhubung. Mulai ulang DSH agar sinkronisasi aktif.\n')
} catch (error) {
  process.stderr.write(`Koneksi gagal: ${error instanceof Error ? error.message : 'CALENDAR_CONNECT_FAILED'}\n`)
  process.exitCode = 1
}
