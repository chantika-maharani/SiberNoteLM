𝗦𝗜𝗕𝗘𝗥𝗡𝗢𝗧𝗘𝗟𝗠

Aplikasi web asisten belajar berbasis AI untuk mahasiswa. Pengguna mengunggah dokumen materi kuliah, lalu berinteraksi dengan AI untuk bertanya, merangkum per bab, dan membuat flashcard. Setiap jawaban disertai rujukan ke halaman dokumen sumber.

Proyek mata kuliah Manajemen Proyek Perangkat Lunak, dikembangkan dengan metode Scrum oleh kelompok 2 SiberNoteLM.


𝗚𝗔𝗠𝗕𝗔𝗥𝗔𝗡 𝗨𝗠𝗨𝗠

SiberNoteLM menjawab pertanyaan berdasarkan dokumen yang diunggah pengguna dan sumber luar jika jawaban tidak tersedia pada dokumen yang pengguna unggah. Jawaban AI memuat tag rujukan (misalnya PDF, hlm. 12) yang membuka pratinjau halaman sumber, sehingga pengguna dapat memverifikasi jawaban.

Antarmuka berupa ruang kerja tiga kolom:
• 𝗦𝘂𝗺𝗯𝗲𝗿: daftar dokumen dan pratinjau halaman
• 𝗖𝗵𝗮𝘁 𝗔𝗜: tanya jawab, ringkasan per bab, dan pembuatan flashcard
• 𝗥𝘂𝗮𝗻𝗴 𝗖𝗮𝘁𝗮𝘁𝗮𝗻: catatan yang disimpan pengguna


𝗟𝗔𝗧𝗔𝗥 𝗕𝗘𝗟𝗔𝗞𝗔𝗡𝗚

Mahasiswa sering kesulitan mengelola materi kuliah yang tersebar di banyak berkas, dan ingin jawaban AI yang bisa dilacak ke sumbernya. Kebutuhan pengguna dirumuskan dari survei terhadap 32 mahasiswa:
• 𝟱𝟯,𝟭% responden kesulitan menyatukan materi kuliah yang tercecer.
• 𝟴𝟳,𝟱% responden mewajibkan penunjuk nomor halaman pada rangkuman dan jawaban AI (prioritas tertinggi).
• 𝟲𝟱,𝟲% responden memilih belajar bertahap per bab dibandingkan rangkuman utuh satu buku.
• 𝟵𝟬,𝟲% responden (29 dari 32) menilai fitur evaluasi mandiri seperti flashcard penting.

Hasil survei ini menjadi dasar fitur sitasi halaman, pelajari per bab, dan flashcard.


𝗙𝗜𝗧𝗨𝗥

𝗛𝗮𝗹𝗮𝗺𝗮𝗻 𝗮𝘄𝗮𝗹
• Landing page

𝗗𝗼𝗸𝘂𝗺𝗲𝗻 𝗱𝗮𝗻 𝗔𝗜
• Unggah dokumen PDF, DOCX, PPTX, dan TXT (termasuk PDF hasil pindai melalui OCR) lewat tombol "Tambah Sumber +" atau drag-and-drop (satu file per kali)
• Chat AI dengan rujukan halaman pada setiap jawaban
• Pratinjau dokumen dari tag rujukan, atau dengan menekan nama dokumen di daftar Sumber (dibuka dari halaman pertama dan dapat digulir antarhalaman)
• Riwayat obrolan
• Pelajari per bab: pemetaan bab dokumen dan ringkasan per bab
• Flashcard: pembuatan kartu belajar dari dokumen terpilih (3, 5, 7, atau 10 kartu)

𝗗𝗮𝘀𝗵𝗯𝗼𝗮𝗿𝗱 𝗰𝗮𝘁𝗮𝘁𝗮𝗻
• Daftar catatan dengan jumlah total, sumber, dan tanggal
• Pengurutan berdasarkan terbaru dan abjad (A–Z)
• Pencarian catatan
• Pagination (10 catatan per halaman)
• Sematkan catatan

𝗔𝗸𝘂𝗻
• Registrasi dan login
• Pengaturan profil: foto, username, dan password


𝗟𝗜𝗡𝗚𝗞𝗨𝗣 𝗗𝗔𝗡 𝗕𝗔𝗧𝗔𝗦𝗔𝗡

𝗗𝗶 𝗱𝗮𝗹𝗮𝗺 𝗹𝗶𝗻𝗴𝗸𝘂𝗽: pengolahan dokumen teks (PDF, DOCX, PPTX, dan TXT) dengan pipeline hybrid teks dan OCR, tanya jawab berbasis dokumen dengan sitasi halaman, interaksi terpandu dan ringkasan per bab, serta flashcard.

𝗗𝗶 𝗹𝘂𝗮𝗿 𝗹𝗶𝗻𝗴𝗸𝘂𝗽 (tidak dibangun pada proyek ini):
• Visualisasi mind map atau diagram alur konsep.
• Ringkasan suara otomatis (audio overview).
• Pemrosesan konten video YouTube.
• Berbagi dokumen atau catatan ke ruang publik. Seluruh berkas dan catatan bersifat pribadi pada ruang kerja masing-masing pengguna.

𝗕𝗮𝘁𝗮𝘀𝗮𝗻 𝘂𝗻𝗴𝗴𝗮𝗵𝗮𝗻: maksimal 100 halaman atau 20 MB per berkas. Batas ini menjaga pemrosesan OCR dan kuota API model bahasa tetap dalam kapasitas server.


𝗖𝗔𝗥𝗔 𝗞𝗘𝗥𝗝𝗔

Aplikasi memakai pendekatan retrieval-augmented generation (RAG):
1. 𝗜𝗻𝗴𝗲𝘀𝘁. Dokumen yang diunggah dipecah menjadi chunk beserta metadata halaman. Dokumen hasil pindai diproses dengan OCR. Embedding setiap chunk disimpan di MongoDB Atlas.
2. 𝗥𝗲𝘁𝗿𝗶𝗲𝘃𝗮𝗹. Pertanyaan pengguna dicocokkan dengan chunk melalui MongoDB Atlas Vector Search (maksimal 5 chunk).
3. 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗶𝗼𝗻. Chunk hasil pencarian, beserta dua percakapan terakhir sebagai konteks, dikirim ke model Gemini Flash.
4. 𝗥𝘂𝗷𝘂𝗸𝗮𝗻. Respons menyertakan sitasi (dokumen dan halaman) yang ditampilkan sebagai tag rujukan.

Penomoran halaman mengikuti jenis dokumen: PDF memakai halaman asli, PPTX memakai nomor slide, sedangkan TXT dan DOCX dihitung per 3000 karakter karena format tersebut tidak menyimpan nomor halaman yang dapat dibaca secara andal.


𝗠𝗔𝗞𝗡𝗔 𝗟𝗢𝗚𝗢

Logo SiberNoteLM berupa tiga lembar dokumen isometrik yang bertumpuk. Bentuk dan warnanya dipilih karena menggambarkan inti aplikasi.

𝗕𝗲𝗻𝘁𝘂𝗸: 𝘁𝘂𝗺𝗽𝘂𝗸𝗮𝗻 𝘁𝗶𝗴𝗮 𝗱𝗼𝗸𝘂𝗺𝗲𝗻
• 𝗥𝘂𝗮𝗻𝗴 𝗸𝗲𝗿𝗷𝗮 𝘁𝗶𝗴𝗮 𝗸𝗼𝗹𝗼𝗺. Tiga lembar dokumen mewakili tiga kolom ruang kerja. Dibandingkan tiga kolom yang berjejer vertikal (terkesan kaku), tumpukan memberi kesan ruang yang lebih dinamis.
• 𝗔𝗹𝘂𝗿 𝗯𝗲𝗹𝗮𝗷𝗮𝗿 𝗯𝗲𝗿𝘁𝗮𝗵𝗮𝗽. Tiap lembar mewakili satu tahap belajar:
   - Lembar paling bawah (pondasi): kolom Sumber, dasar pengetahuan.
   - Lembar tengah (proses): kolom Chat AI, tempat AI mengekstrak dan mengolah informasi dari sumber.
   - Lembar paling atas (hasil akhir): kolom Catatan, rangkuman rapi yang siap dibaca mahasiswa.
• 𝗥𝗮𝗽𝗶 𝗱𝗮𝗻 𝘁𝗲𝗿𝗼𝗿𝗴𝗮𝗻𝗶𝘀𝗮𝘀𝗶. Kertas yang tertumpuk sejajar memberi kesan produktif dan menjanjikan bahwa materi kuliah yang berantakan dirapikan di satu tempat yang terstruktur.


𝗧𝗘𝗞𝗡𝗢𝗟𝗢𝗚𝗜

• 𝗕𝗮𝘀𝗶𝘀 𝗱𝗮𝘁𝗮 𝗱𝗮𝗻 𝗽𝗲𝗻𝗰𝗮𝗿𝗶𝗮𝗻 𝘃𝗲𝗸𝘁𝗼𝗿: MongoDB Atlas, Atlas Vector Search
• 𝗠𝗼𝗱𝗲𝗹 𝗯𝗮𝗵𝗮𝘀𝗮: Google Gemini Flash
• 𝗣𝗲𝗺𝗯𝗮𝗰𝗮 𝗱𝗼𝗸𝘂𝗺𝗲𝗻: officeparser (DOCX dan PPTX), OCR untuk PDF hasil pindai


𝗧𝗜𝗠

• 𝗣𝗿𝗼𝗷𝗲𝗰𝘁 𝗠𝗮𝗻𝗮𝗴𝗲𝗿 / 𝗦𝗰𝗿𝘂𝗺 𝗠𝗮𝘀𝘁𝗲𝗿: Chantika Maharani 
• 𝗨𝗜/𝗨𝗫: Kamalul Iman
• 𝗙𝗿𝗼𝗻𝘁-𝗘𝗻𝗱: Muhammad ‘Arif  Nur Shidiq
• 𝗕𝗮𝗰𝗸-𝗘𝗻𝗱: Muhammad Raffi 
• 𝗦𝗤𝗔: Sabbicarel Edward Piris 


𝗦𝗧𝗔𝗧𝗨𝗦 𝗣𝗥𝗢𝗬𝗘𝗞

Dikembangkan dalam lima sprint. Fitur Flashcard dan Pelajari per bab dikerjakan pada Sprint 4. 
Sprint 5 menambahkan landing pag, drag-and-drop untuk menambah dokumen, dan pratinjau dari daftar Sumber.
