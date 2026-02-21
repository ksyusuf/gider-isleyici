from oauth2client.service_account import ServiceAccountCredentials
from googleapiclient import discovery
import datetime
import os


class GoogleSheets:
    def __init__(self, spreadsheet_id: str, sheet_id: int, key_path: str, logger=None):
        """Pure service: provide all config via constructor from entrypoint.
        - spreadsheet_id: Google Sheets id
        - sheet_id: sheet numeric id
        - key_path: path to service account JSON key
        - logger: optional logger with AddLog()
        """
        self.scope = [
            "https://spreadsheets.google.com/feeds",
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
        ]

        self.spreadsheet_id = spreadsheet_id
        self.sheet_id = sheet_id
        self._key_path = key_path
        self.logger = logger
        self.creds = ServiceAccountCredentials.from_json_keyfile_name(self._key_path, self.scope)
        self.service = discovery.build('sheets', 'v4', credentials=self.creds)

    def veri_ekleme(self, return_edilmis_veri):
        """
        FORMAT: [ {TARİH, TUTAR, FİRMA, TÜR, MALZEME, AÇIKLAMA}, ...]
        tarih formatı: dd.mmmm.yyyy

        :param return_edilmis_veri: bir listedir. listenin her bir elemanı sözlütür.
            her bir sözlüğün yapısı: {TARİH, TUTAR, FİRMA, TÜR, MALZEME, AÇIKLAMA} şeklindedir.
        :return:
        """

        if self.logger:
            self.logger.AddLog("Yükleniyor...")
        else:
            print("Yükleniyor...")
        yazdirilacak_veri = []

        for harcama in return_edilmis_veri:
            # datetime modulünde 1. değer 01/01/0001 tarihine karşılık geliyor.
            # excelde 1. değer 31/12/1899 tarihine karşılık geliyor.
            # python ve excel tarih değer farkı = 693.594 693594
            # gelen tarih değerinin üzerinde işlem yapabilmek için
            # onu matematiksel ifadeye dönüştürdüm.
            tarih = harcama["tarih"]  # buradan datetime formatında veri gelecek
            gelen_gun_degeri = datetime.date(year=tarih.year, month=tarih.month, day=tarih.day).toordinal()
            # print("gelen gun değeri", gelen_gun_degeri)
            gelen_gun_degeri = gelen_gun_degeri - 693594

            yazdirilacak_veri.insert(0,
                                     [
                                         gelen_gun_degeri,
                                         float(harcama['tutar']),
                                         harcama['firma'],
                                         harcama['tür'],
                                         harcama['malzeme'],
                                         harcama['açıklama']
                                     ])
            # insert kullanmamın sebebi;
            #   lokal olarak tarih sıralaması yapıyor fakat aynı tarihler için
            #   en son yazılan, veritabanında en üstte gözükmesi için toplu yüklemelerde
            #   bu şekilde bir yazdırma tercih ettim.

        range_ = 'D3:I3'
        # sanıyorum, execute için append kullandığımız için
        # burada veri varsabile  o direkt sona ekleme yapıyor.

        value_range_body = {
            "values": yazdirilacak_veri
        }

        request = self.service.spreadsheets().values() \
            .append(spreadsheetId=self.spreadsheet_id,
                    range=range_,
                    valueInputOption='USER_ENTERED',
                    insertDataOption='INSERT_ROWS',
                    body=value_range_body)

        response = request.execute()  # response: sözlük tipinde bir veridir.

        requests = {
            "requests": [
                {
                    "sortRange": {
                        "range": {
                            "sheetId": self.sheet_id,
                            "startRowIndex": 1,
                            "startColumnIndex": 0,
                        },
                        "sortSpecs": [
                            {
                                "dimensionIndex": 3,
                                "sortOrder": "DESCENDING"
                            }
                        ]
                    }
                }
            ]
        }
        self.service.spreadsheets().batchUpdate(body=requests,
                                                spreadsheetId=self.spreadsheet_id).execute()

        if self.logger:
            self.logger.AddLog('Sıralama tamamlandı.')
            self.logger.AddLog("Güncellenen satır sayısı: " + str(response['updates']['updatedRows']))
            self.logger.AddLog("Yükleme tamamlandı.")
        else:
            print('Sıralama tamamlandı.', 'Güncellenen satır sayısı:', response.get('updates', {}).get('updatedRows'))


if __name__ == '__main__':
    # Debug runner: load .env from project root so module can be run directly for debugging.
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(project_root, '.env')
    if os.path.exists(env_path):
        from dotenv import load_dotenv

        load_dotenv(env_path)

    # Read env vars (allow running with environment or .env)
    sid = os.environ.get('spreadsheet_id')
    sheet_id = os.environ.get('sheet_id')
    key = os.environ.get('JSON')
    if not sid or not sheet_id or not key:
        print('Set spreadsheet_id, sheet_id and JSON env vars (or create .env in project root) before running this module for debug.')
    else:
        sheets = GoogleSheets(spreadsheet_id=sid, sheet_id=int(sheet_id), key_path=key)
        gelen_gun_tarihi = datetime.date(year=2026, month=11, day=5)
        yuklenen_veri = [{'tarih': gelen_gun_tarihi,
                          'tutar': 55,
                          'firma': 'öncelikle merhaba',
                          'tür': 'Kişisel',
                          'malzeme': 'Nargile',
                          'açıklama': f"{datetime.datetime.now()}"}]
        sheets.veri_ekleme(yuklenen_veri)
