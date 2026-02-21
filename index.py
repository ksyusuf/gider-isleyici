from flask import Flask, render_template, request
import datetime
import os
from dotenv import load_dotenv

# Load .env once (only in entrypoint)
project_root = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(project_root, '.env'))

# Create configured service instances and coordinator
from services.DocsGoogle import GoogleDocs
from services.SheetsGoogle import GoogleSheets
from services.GoogleDriveLogger import GoogleDriveLogger
from services.main import Kaydedici

# Read required env vars (will raise KeyError if missing)
JSON_KEY = os.environ.get('JSON')
DOCUMENT_ID = os.environ.get('DOCUMENT_ID')
LOG_DOCS_ID = os.environ.get('log_docs_id')
SPREADSHEET_ID = os.environ.get('spreadsheet_id')
SHEET_ID = int(os.environ.get('sheet_id')) if os.environ.get('sheet_id') else None

logger = GoogleDriveLogger(document_id=LOG_DOCS_ID, key_path=JSON_KEY)
docs_service = GoogleDocs(document_id=DOCUMENT_ID, key_path=JSON_KEY, logger=logger)
sheets_service = GoogleSheets(spreadsheet_id=SPREADSHEET_ID, sheet_id=SHEET_ID, key_path=JSON_KEY, logger=logger)

# coordinator instance used by routes
kaydedici = Kaydedici(docs_service, sheets_service, logger)

# otomatik requirements.txt oluşturmak için
# pip3 freeze > requirements.txt

app = Flask(__name__)


@app.route('/')
def AnaSayfa():
    current_year = datetime.datetime.now().year
    return render_template('ana_sayfa.html', current_year=current_year)


@app.route("/goruntule", methods=['POST', 'GET'])
def goruntuleyici():
    if request.method == 'POST':
        veriler = kaydedici.Goruntule()

        if veriler == "Doküman boş.":
            return "Doküman boş."
        else:
            return veriler
    else:
        return "Bu sayfayı görmeye yetkiniz yok!"  # get metodu ile gelirsen bu çalışır


@app.route("/kayit", methods=['POST', 'GET'])
def kayit_route():
    if request.method == 'POST':
        return kaydedici.kayit()
    else:
        return "Bu sayfayı görmeye yetkiniz yok!"  # get metodu ile gelirsen bu çalışır


@app.route("/yanSayfa")
def yanSayfa():
    return render_template("yan_sayfa.html")


# YAN SAYFA AŞAĞIDA ==============================================================================

@app.route("/devamEt", methods=['POST', 'GET'])
def devamEt():
    if request.method == 'POST':
        return "devamEt POST metodu..."
    else:
        return "devamEt get metodu..."


@app.route("/durdur", methods=['POST', 'GET'])
def durdur():
    if request.method == 'POST':
        return "Henüz Çalışmıyor."
    else:
        return "durdur get metodu..."


@app.route("/gizlilik-politikasi")  # anasayfa bu route ile oluşuyor sanırım. okey
def gizlilik():
    return render_template("gizlilik_politika_sayfasi.html")


@app.route("/kullanim-kosullari")  # anasayfa bu route ile oluşuyor sanırım. okey
def kullanim():
    return render_template("kullanim_kosullari.html")


# ===============================================================================================

if __name__ == '__main__':
    app.debug = os.environ.get("DEBUG", "False") == "True"
    port = int(os.environ.get("PORT", 2000))
    app.run(host="0.0.0.0", port=port)
