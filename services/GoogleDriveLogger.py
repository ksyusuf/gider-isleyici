from googleapiclient.discovery import build
import os
from oauth2client.service_account import ServiceAccountCredentials
import datetime
import pytz


class GoogleDriveLogger:
    def __init__(self, document_id: str, key_path: str):
        """Pure logger service. Accept config from caller (no env reads here).
        - document_id: Google Docs document id to write logs into
        - key_path: path to service account JSON key
        """
        self.icerik = None
        self.document = None
        self.dokuman_uzunlugu = None
        # burada istediğin kadar izin istiyor ilk girişte. sonra token'ı oluşturuyor.
        # Token'ı oluşturmasa bile lazım bu.
        SCOPES = ['https://www.googleapis.com/auth/drive']

        self.DOCUMENT_ID = document_id
        self._key_path = key_path
        creds = ServiceAccountCredentials.from_json_keyfile_name(self._key_path, SCOPES)
        self.service = build('docs', 'v1', credentials=creds)

    def IcerigiCek(self):
        try:
            self.document = self.service.documents().get(documentId=self.DOCUMENT_ID).execute()
        except Exception as e:
            print(str(e))
            return "İçerik çekme işlemi başarısız. Konsolu kontrol ediniz."

        doc_content = self.document.get('body').get('content')
        # eğer dokümanda senin api mailine erişim izni verilmemişse hata alırsın.
        # todo: bu hatanın önüne geçmek için ilk çalıştırmada izin isteyen pencere açabilir misin?
        # izin işlemi için google penceresi açılabilirse daha sunulabilir bir proje olur.

        from services.DocsGoogle import read_strucutural_elements
        # DocsGoogle'ı içeriden çalıştırdığım zaman hata aldığım için bunu burada import ettim.
        self.icerik = read_strucutural_elements(doc_content)
        self.dokuman_uzunlugu = len(self.icerik)

    def AddLog(self, *message):
        """ Dokümana log kaydı ekler. """
        self.IcerigiCek()
        message = ' '.join(map(str, message))

        # sunucudaysan bu aktif.
        utc_date = datetime.datetime.now(pytz.timezone('Europe/Istanbul'))  # İstanbul zaman dilimi örneği (utc+3)
        Log = f"{datetime.datetime.strftime(utc_date, '%d-%m-%Y %H:%M:%S')} - {message}"

        # lokaldeysen bu çalışsın. ama zaten lokalim utc+3
        # Log = f"{datetime.datetime.strftime(datetime.datetime.now(), '%d-%m-%Y %H:%M:%S')} - {message}"

        # todo: dokümanın sonuna ekleme yapmak için her seferinde veriyi çekmesek daha iyi olur.
        requests = [
            {
                'insertText': {
                    'location': {
                        'index': self.dokuman_uzunlugu,
                    },
                    'text': "\n" + Log
                }
            }
        ]

        self.service.documents().batchUpdate(
            documentId=self.DOCUMENT_ID,
            body={'requests': requests}).execute()

    def delete_old_logs(self, days=30):
        """ verilen gün sayısı kadar eskideki logları temizler
        :param days: int türünde gün sayısı
        """
        current_time = datetime.datetime.now()
        cutoff_time = current_time - datetime.timedelta(days=days)
        print("Öncesi silinecek: ", cutoff_time)
        self.AddLog(f"Öncesi silinecek: {datetime.datetime.strftime(cutoff_time, '%d-%m-%Y %H:%M:%S')}")

        # try:
        # Dosyanın sadece ilk satırını oku ve yazdır
        # print(self.icerik.splitlines()[0])
        first_line = self.icerik.splitlines()[0]

        # İlk satır boşsa işlem yapma
        if not first_line:
            print("ilk satır boş")
            self.AddLog("ilk satır boş")
            return

        # İlk satırdaki tarih bilgisini kontrol et
        log_time = self._get_log_time(first_line)
        if log_time >= cutoff_time:
            print(f"{days} günden eski kayıt yok")
            self.AddLog(f"{days} günden eski kayıt yok")
            return  # 30 saniyeden eski kayıt yoksa işlem yapma

        silinecek_kisim_uzunlugu = 0
        silinen_log_sayisi = 0

        logs = self.icerik.splitlines()

        for a_log in logs:
            if cutoff_time >= self._get_log_time(a_log):
                silinecek_kisim_uzunlugu += len(a_log)+1
                silinen_log_sayisi += 1
                # +1 satırbaşı ifadesi için.
                # satırbaşı \n olarak 2 karakter sayılmıyor demek ki. (?)

        requests = [
            {
                'deleteContentRange': {
                    'range': {
                        'startIndex': 1,
                        'endIndex': silinecek_kisim_uzunlugu+1,
                    }
                }
            },
        ]
        result = self.service.documents().batchUpdate(
            documentId=self.DOCUMENT_ID, body={'requests': requests}).execute()

        self.AddLog("Eski kayıtlar temizlendi.")
        self.AddLog("silinen kayıt sayısı: ", silinen_log_sayisi)
        # except Exception as e:
        #     # Hata durumunda log al
        #     self.AddLog(f"Log silme hatası: {str(e)}")

    def _get_log_time(self, log_line):
        """
        verilen logun tarihini ayrıştırır.
        :param log_line: tarih - sonuç formatında log satırı
        :return: log tarihi
        """
        date_str = log_line.split(' - ', 1)[0]
        return datetime.datetime.strptime(date_str, '%d-%m-%Y %H:%M:%S')


if __name__ == '__main__':
    # Debug runner: load .env from project root so the module can be run directly.
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(project_root, '.env')
    if os.path.exists(env_path):
        from dotenv import load_dotenv

        load_dotenv(env_path)

    doc_id = os.environ.get('log_docs_id')
    key = os.environ.get('JSON')
    if not doc_id or not key:
        print('Set LOG_DOCS_ID and JSON env vars (or create .env in project root) before running this module for debug.')
    else:
        docs = GoogleDriveLogger(document_id=doc_id, key_path=key)
        docs.IcerigiCek()
        docs.AddLog("selam", "bu bir log")
        docs.delete_old_logs()
