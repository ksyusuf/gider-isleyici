from services import SheetsGoogle, DocsGoogle
import datetime


class Kaydedici:
    def __init__(self, docs_service, sheets_service, logger):
        """Coordinator class. Require explicit service instances from entrypoint.
        - docs_service: instance of DocsGoogle.GoogleDocs
        - sheets_service: instance of SheetsGoogle.GoogleSheets
        - logger: instance providing AddLog/delete_old_logs
        """
        self.dokumanim = docs_service
        self.excelim = sheets_service
        self.log = logger

    def kayit(self):
        """
        Kayıt işlemini gerçekleştirir.
        """
        self.log.AddLog(40 * "-")
        self.log.AddLog("Kayıt emri verildi. Çalışma başladı.")

        self.dokumanim.IcerigiCek()  # dokümanın boş olduğunu kontrol etmeden önce içeriği çekmelisin
        if not self.dokumanim.dokumanBosMu():
            self.dokumanim.verileriDuzenle()
            self.excelim.veri_ekleme(self.dokumanim.WebeGonder())
            # WebeGonder'i çalıştırmadan önce veriyi çekmiş olmalısın [ IcerigiCeK() ]
            print("Kaydedildi.")

            # kaydı yaptıktan sonra log defterini de temizleyelim.
            self.log.delete_old_logs(days=30)
            self.docsTemizleme()
            self.log.AddLog("Kayıt işlemi tamamlandı.", datetime.datetime.strftime(datetime.datetime.now(), '%A'))
            self.log.AddLog(40 * "-")
            return "Kayıt işlemi tamamlandı."
        else:
            return "Doküman Boş!"

    def docsTemizleme(self):
        self.dokumanim.tumunuSil()

    def veriKonsolaYazdir(self):
        """pek önemli olmayan fonksiyon"""
        self.dokumanim.IcerigiCek()
        self.dokumanim.verileriDuzenle()
        self.dokumanim.KonsolaYazdir()

    def Goruntule(self):
        """
        verileri okunabilir şekilde görüntüler.
        :return: str
        """
        print("Görüntülendi.")
        self.dokumanim.IcerigiCek()
        if self.dokumanim.dokumanBosMu():
            self.log.AddLog("Görüntüleme isteği: Doküman boş.")
            return "Doküman boş."
        else:
            self.dokumanim.verileriDuzenle()
            self.log.AddLog("Harcamalar görüntülendi.")
            return self.dokumanim.WebeGonder()

    def PeriyodikIsleme(self):
        """
        normalde bu fonksiyonun belli periyotlar ile kayıt işlemini yaparken
        kullanmam gerekiyordu. fakat sunuculardaki worker yapılarını kullanamadığım
        için sadece kayıt işlemi yapacak şekilde kaldı. önemli değil şimdilik.
        :return:
        """
        self.log.AddLog(40 * "-")
        self.log.AddLog("Kayıt emri periyodik işleme ile verildi. Çalışma başladı.")
        sonuc = self.kayit()
        self.log.AddLog(sonuc, datetime.datetime.strftime(datetime.datetime.now(), '%A'))
        self.log.AddLog(40 * "-")
        return sonuc


if __name__ == '__main__':
    # Load .env from project root for convenience when running this module directly.
    import os
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(project_root, '.env')
    if os.path.exists(env_path):
        from dotenv import load_dotenv

        load_dotenv(env_path)

    print("main, içeriden çağırıldı.")
    print('This module is a coordinator. Create service instances in your entrypoint and pass them to Kaydedici.')
