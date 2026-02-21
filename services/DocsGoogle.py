from __future__ import print_function
from googleapiclient.discovery import build
from oauth2client.service_account import ServiceAccountCredentials
import datetime


# BU FONKSİYONLAR DÜZENLİ ÇIKTI ALABİLMEMİ SAĞLIYOR
def read_paragraph_element(element):
    """ Dokümandaki elementlere göre ayıklama yapıyor
        Args:
            element: GoogleDocs'taki içeriğin content kısmını alır.
    """
    text_run = element.get('textRun')
    if not text_run:
        return ''
    return text_run.get('content')


def read_strucutural_elements(elements):
    """ Metnin tüm elementlerini inceler aradan içeriği temize çeker.
        Args:
            elements: Elementlerin listesini alır.
    """
    text = ''
    for value in elements:
        if 'paragraph' in value:
            elements = value.get('paragraph').get('elements')
            for elem in elements:
                text += read_paragraph_element(elem)
        elif 'table' in value:
            # The text in table cells are in nested Structural Elements and tables may be
            # nested.
            table = value.get('table')
            for row in table.get('tableRows'):
                cells = row.get('tableCells')
                for cell in cells:
                    text += read_strucutural_elements(cell.get('content'))
        elif 'tableOfContents' in value:
            # The text in the TOC is also in a Structural Element.
            toc = value.get('tableOfContents')
            text += read_strucutural_elements(toc.get('content'))
    return text


ay_sirasi = {
    "ocak": 1,
    "şubat": 2,
    "mart": 3,
    "nisan": 4,
    "mayıs": 5,
    "haziran": 6,
    "temmuz": 7,
    "ağustos": 8,
    "eylül": 9,
    "ekim": 10,
    "kasım": 11,
    "aralık": 12
}


class GoogleDocs:
    def __init__(self, document_id: str, key_path: str, logger=None):
        """Pure service: accept config from caller (no env reads here).
        - document_id: Google Docs document id
        - key_path: path to service account JSON key
        - logger: optional object with AddLog() method for logging
        """
        self.return_edilecek_harcamalar = []
        self.document = None
        self.dokuman_uzunlugu = None
        self.icerik = None
        # burada istediğin kadar izin istiyor ilk girişte. sonra token'ı oluşturuyor.
        # Token'ı oluşturmasa bile lazım bu.
        SCOPES = ['https://www.googleapis.com/auth/drive']

        # explicit config from caller
        self.DOCUMENT_ID = document_id
        self._key_path = key_path
        self.logger = logger
        creds = ServiceAccountCredentials.from_json_keyfile_name(self._key_path, SCOPES)

        self.service = build('docs', 'v1', credentials=creds)

    def IcerigiCek(self):
        # Retrieve the documents contents from the Docs service.
        try:
            self.document = self.service.documents().get(documentId=self.DOCUMENT_ID).execute()
        except Exception as e:
            if self.logger:
                self.logger.AddLog(str(e))
            else:
                print(str(e))
        # print('Dokümanınızın başlığı: {}'.format(self.document.get('title')))

        doc_content = self.document.get('body').get('content')
        self.icerik = read_strucutural_elements(doc_content)
        self.dokuman_uzunlugu = len(self.icerik)

        # print("doküman uzunluğu: ", self.dokuman_uzunlugu, "karakter")
        # print(self.icerik)

        # title = "başlık_!"
        # Make a request body
        # requests = {'title': title}
        # böyle bir istek oluşturduk ama bunu execute etmediğimiz sürece gitmez.

        # Create the document
        # doc = service.documents().create(body=requests).execute()
        # print(doc) # belgenin mevcut tüm özelliklerini yazdırıyor

    def tumunuSil(self):
        """Dokümanı temizler."""
        if self.dokuman_uzunlugu > 1:
            requests = [
                {
                    'deleteContentRange': {
                        'range': {
                            'startIndex': 1,
                            'endIndex': self.dokuman_uzunlugu,
                        }
                    }
                },
            ]
            result = self.service.documents().batchUpdate(
                documentId=self.DOCUMENT_ID, body={'requests': requests}).execute()
            if self.logger:
                self.logger.AddLog("Tüm içerik silindi.")
            else:
                print("Tüm içerik silindi.")
        else:
            print("Doküman boş.")
            # log.log_info("Silme başarısız. (Doküman boş.)")

    def durumSifirlayici(self):
        self.firmaMi = False
        self.turMu = False
        self.malzemeMi = False
        self.aciklamaMi = False
        self.yemekMi = False

    def dokumanBosMu(self):
        if self.dokuman_uzunlugu <= 1:
            return True

    def verileriDuzenle(self):
        # clear previous results so repeated calls don't duplicate data
        self.return_edilecek_harcamalar.clear()
        while True:
            # düzenlenecek veriyi fazla satırlardan arındırır.
            if "\n\n" not in self.icerik:
                break
            else:
                self.icerik = self.icerik.replace("\n\n", "\n")

        while True:
            # düzenlenecek veriyi fazla boşluk karakterlerinden arındırır.
            if "  " not in self.icerik:
                break
            else:
                self.icerik = self.icerik.replace("  ", " ")

        gunler = self.icerik.splitlines()
        # tüm veriyi \n karakterinden, yani satırbaşlarından ayırdım.
        # çünkü her yeni tarihi satırabaşı ile ifade ediyorum.

        bir_adet_harcama = {}

        firma = []
        tur = []
        malzeme = []
        aciklama = []
        karaktersiz = []

        def BirAdetYazdirma():
            bir_adet_harcama["tutar"] = str(harcama)  # tutarı şimdilik string olarak kaydediyorum.
            # duruma göre ondalık sayı olarak kaydederim.

            bir_adet_harcama["tarih"] = duzenli_tarih

            bir_adet_harcama["firma"] = " ".join(firma)
            firma.clear()

            bir_adet_harcama["tür"] = " ".join(tur)
            tur.clear()

            bir_adet_harcama["malzeme"] = " ".join(malzeme).capitalize()
            malzeme.clear()

            bir_adet_harcama["açıklama"] = " ".join(aciklama)
            aciklama.clear()

            karaktersiz_aciklama = " ".join(karaktersiz)
            if not karaktersiz:  # karaktersizler listesi boş ise pas geçsin yoksa yazdırsın.
                pass
            else:
                bir_adet_harcama["açıklama"] = "@ " + karaktersiz_aciklama
                karaktersiz.clear()

            self.return_edilecek_harcamalar.append(bir_adet_harcama.copy())
            bir_adet_harcama.clear()

        self.durumSifirlayici()  # bu fonksiyonla durumları çağırdım döngüye.

        for BirGun in gunler:

            tarih = BirGun.split(" ", 2)[:2]
            # ikinci boşluk tarihten sonrasını ifade ediyor. örneğin
            # 29 şubat bla bla bla (harcama kısmı)
            # ikinci boşluktan bölüp soldaki parçayı alınca tarihi almış oluyoruz.
            try:
                harcama_kismi = BirGun.split(" ", 2)[2:][0].replace(",", ".")
                # ikinci boşluktan bölüp sağdaki parçayı alınca HARCAMA kısmını almış oluyoruz.
                # ayrıca ondalık ayıracı olarak . kullanıldığından, ondalık değerlerin düzeltilmesi için
                # virgülleri nokta ile değiştriyoruz.
                # bunun sebebi harcama içinde ondalıklı işlem var ise eval fonksiyonu hata vermemesidir.
                # ancak tüm içerikteki virgülleri etkiliyor bu. yani açıklama kısmına vigüllü bir şey yazarsan
                # bu nokta olur.
                # print(harcama_kismi)
            except Exception as e:
                # Hata durumunda log al
                    if self.logger:
                        self.logger.AddLog(f"İlk satır boş: {str(e)}")
                    else:
                        print(f"İlk satır boş: {str(e)}")

            tarih_gun = tarih[0].zfill(2)
            # tarihin gün kısmını veriyo başında sıfır olarak iki haneli şekilde ( 2 kasım => 02 kasım )
            tarih_ay = tarih[1]  # tarihin ay kısmını alıyor.
            # tarihe ek olarak yılı da eklemem gerekebilir. excelin formatına göre.
            # şimdilik programı çalıştırdığımız tarihin yılı ile kayıt gerçekleştiriliyor.
            tarih_yil = str(datetime.datetime.now().year)
            duzenli_tarih = datetime.date(year=int(tarih_yil), month=int(ay_sirasi[tarih_ay.lower()]),
                                          day=int(tarih_gun))
            # girilmiş tarihi datetime modülü ile okunabilir hale getiriyoruz. excele işlemede işimize yaryacak.
            # print("harcama kısmı string: " + harcama_kismi)
            anahtar = "#"

            for harcama in harcama_kismi.split(" "):
                # harcama kısmını kelime kelime ele alıyoruz.
                # işlem yapılabilir sayı görene kadar kelimeleri ilgili hücrelere kaydediyor.
                # örneğin ulaşım kategorisindeki harcamayı görünce ulaşım değeri olduğunu kaydediyor.
                # sistem biraz tersten işliyor. ilk başta sayı değeri olup olmadığını kontrol ediyor
                # eğer sayı değilse (tutar) içerik bilgisidir deyip ilgili yerlere işleme yapıyoruz.
                if harcama[0] == "*":
                    harcama = eval(harcama[1:])  # güvenlik açığı !!!
                    # harcamanın tutar kısmına geldik demektir. ondalıkları da düzenleyelim
                    harcama = round(harcama, 2)
                    BirAdetYazdirma()
                    self.durumSifirlayici()
                    continue
                else:
                    # buraya geldiyse demek ki bu bir karakter dizisi, işlenecek.
                    if harcama[0] == anahtar:
                        # harcama denilen şey belirteç ise ilk karakteri '#'dir. bunun kontrolünü sağlıyoruz.
                        # eğer belirteçe denk geldiyse ikinci karakterine göre yerleşim yapıyoruz.
                        # örneğin #t ulaşım --- bu; harcamanın türünün ulaşım olduğunu ifade ediyor.
                        # ben şimdi özel karakterler ayarlayabilecek şekilde modifikasyon sağlayacağım.
                        #     self.KategoriKontrol(harcama[1])
                        if harcama[1] == "f":
                            self.firmaMi = True
                            self.turMu = False
                            self.malzemeMi = False
                            self.aciklamaMi = False
                            self.yemekMi = False
                            continue
                        elif harcama[1] == "t":
                            self.firmaMi = False
                            self.turMu = True
                            self.malzemeMi = False
                            self.aciklamaMi = False
                            self.yemekMi = False
                            continue
                        elif harcama[1] == "m":
                            self.firmaMi = False
                            self.turMu = False
                            self.malzemeMi = True
                            self.aciklamaMi = False
                            self.yemekMi = False
                            continue
                        elif harcama[1] == "a":
                            self.firmaMi = False
                            self.turMu = False
                            self.malzemeMi = False
                            self.aciklamaMi = True
                            self.yemekMi = False
                            continue
                        elif harcama[1] == "y":
                            self.firmaMi = False
                            self.turMu = False
                            self.malzemeMi = False
                            self.aciklamaMi = False
                            self.yemekMi = True
                            continue
                        else:
                            print("Yanlış etiket !!!")

                    if self.firmaMi == True:
                        firma.append(harcama.capitalize())
                        continue
                    elif self.turMu == True:
                        tur.append(harcama.capitalize())
                        continue
                    elif self.malzemeMi == True:
                        malzeme.append(harcama)
                        continue
                    elif self.aciklamaMi == True:
                        aciklama.append(harcama.capitalize())
                        continue
                    elif self.yemekMi == True:  # özel karakter. bu karakterde yemek türü otomatik ekleniyor.
                        firma.append(harcama.capitalize())
                        tur = ["Yemek"]
                        continue
                    else:
                        # print("karaktersizler var!!")
                        karaktersiz.append(harcama)

        # print(self.return_edilecek_harcamalar)
        # print("Harcama sayısı: ", len(self.return_edilecek_harcamalar))

    def KategoriKontrol(self, belirtec):
        """
        Belirteçlere göre durumların değerlerini günceller.
        ilgili duruma True, diğerlerine False değerini atar.
            :param belirtec: tek karakterli string dizisi alır.
        """
        # TODO: fonksiyon henüz açıklamadaki işlevini yerine getiremiyor.
        SorguListesi = [self.firmaMi, self.turMu, self.malzemeMi, self.aciklamaMi, self.yemekMi]
        belirtec_listesi = {
            self.firmaMi: "f",
            self.turMu: "t",
            self.malzemeMi: "m",
            self.aciklamaMi: "a",
            self.yemekMi: "y"
        }

        for kontrol_belirteci, sorgu in belirtec_listesi, SorguListesi:
            self.durumSifirlayici()
            if kontrol_belirteci == sorgu:
                self.firmaMi = False
                self.turMu = False
                self.malzemeMi = False
                self.aciklamaMi = False
                self.yemekMi = False

    def KonsolaYazdir(self):
        """
        Konsola yazdırma fonksiyonu
        ne gerek var buna mq
        """
        for harcama in self.return_edilecek_harcamalar:
            print(
                f"{harcama['tarih']}\t"
                f"{harcama['tutar']}\t"
                f"{harcama['firma']}\t"
                f"{harcama['tür']}\t"
                f"{harcama['malzeme']}\t"
                f"{harcama['açıklama']}"
            )

    def WebeGonder(self):
        """
            Webde görüntüleme fonksiyonu
            :return: return_edilecek_harcamalar [ tuple, tuple, ... ]
        """
        return self.return_edilecek_harcamalar


if __name__ == '__main__':
    # Debug runner: load .env from project root so module can be run directly for debugging.
    import os
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(project_root, '.env')
    if os.path.exists(env_path):
        from dotenv import load_dotenv

        load_dotenv(env_path)

    doc_id = os.environ.get('DOCUMENT_ID')
    key = os.environ.get('JSON')
    if not doc_id or not key:
        print('Set DOCUMENT_ID and JSON env vars (or create .env in project root) before running this module for debug.')
    else:
        print("Docs içeriden çalıştırıldı.")
        docs = GoogleDocs(document_id=doc_id, key_path=key)
        docs.IcerigiCek()
        docs.verileriDuzenle()
        docs.KonsolaYazdir()
    # docs.veriYazdir()
    # docs.tumunuSil()
