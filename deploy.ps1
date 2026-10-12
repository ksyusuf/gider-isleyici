<#
.SYNOPSIS
  gider-isleyici (yayındaki Web App) için push + deploy güncelleme betiği.

.DESCRIPTION
  1. clasp girişini kontrol eder; oturum yoksa/süresi dolduysa `clasp login` başlatır.
  2. Mevcut dağıtımları listeler ve en güncel VERSİYONLU dağıtımı (en yüksek @N,
     @HEAD hariç) bulur. Hiç versiyonlu dağıtım yoksa durur — YENİ dağıtım
     OLUŞTURMAZ (webhook'un kayıtlı olduğu /exec URL'i değişmemeli; bkz. CLAUDE.md).
  3. `clasp push` ile kodu yükler.
  4. Bulunan dağıtım ID'sine `clasp deploy -i <id>` ile yeni versiyon basar (aynı URL).
  5. Sonucu doğrulamak için dağıtımları yeniden listeler.

  Not: dağıtım açıklaması "/" ile BAŞLAMAMALI (Git Bash/MSYS bunu dosya yoluna çevirir).

.PARAMETER Aciklama
  Dağıtım açıklaması: yapılan işin KELİMESEL ÖZETİ (agentic çalışma sonrası deploy'da
  zorunlu kural, bkz. CLAUDE.md). En fazla 200 karakter; fazlası "..." ile kısaltılır.
  Boş bırakılırsa "yyyy-MM-dd HH:mm" + son git commit başlığı kullanılır.
  Google, Apps Script API'sinde `description` için bir üst sınır yayımlamıyor
  (DeploymentConfig: "The description for this deployment."); 200 karakter, kullanıcı
  kararıyla seçilmiş okunabilirlik sınırıdır (Manage deployments listesi uzun metni
  zaten kırpar).

.PARAMETER DeploymentId
  Verilirse otomatik seçim yerine bu dağıtım güncellenir (listede var olmalı).

.EXAMPLE
  powershell -File .\deploy.ps1
#>
param(
  [string]$Aciklama = "",
  [string]$DeploymentId = ""
)

$ACIKLAMA_MAX_KARAKTER = 200

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# Türkçe karakterler: Windows PowerShell 5.1 BOM'suz dosyayı ANSI sanır ve çıktıyı
# OEM kod sayfasıyla yazar. Bu dosya UTF-8 BOM ile kaydedilmeli (kodlama komut
# satırında değil dosyada çözülür) ve konsol/pipe kodlaması UTF-8'e alınır.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Clasp-Calistir {
  # clasp çıktısını (stdout+stderr) tek metin olarak döner; hata kodunu $script:ClaspKod'a yazar.
  param([string[]]$Argumanlar)
  $cikti = & clasp @Argumanlar 2>&1 | ForEach-Object { $_.ToString() }
  $script:ClaspKod = $LASTEXITCODE
  return ($cikti -join "`n")
}

function Aciklama-Hazirla {
  # Boşsa tarih + son commit başlığı; satır sonlarını boşluğa çevirir, baştaki "/"
  # karakterlerini atar (Git Bash/MSYS yol çevirisi) ve 200 karakterle sınırlar.
  param([string]$Metin)
  if ([string]::IsNullOrWhiteSpace($Metin)) {
    $commit = (& git log -1 --pretty=%s 2>$null | Out-String).Trim()
    $Metin = ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $commit).Trim()
  }
  $Metin = ($Metin -replace "\s+", " ").Trim().TrimStart("/").Trim()
  if ($Metin.Length -gt $ACIKLAMA_MAX_KARAKTER) {
    Write-Host ("Uyarı: açıklama {0} karakter, {1} karaktere kısaltıldı." -f $Metin.Length, $ACIKLAMA_MAX_KARAKTER) -ForegroundColor Yellow
    $Metin = $Metin.Substring(0, $ACIKLAMA_MAX_KARAKTER - 3).TrimEnd() + "..."
  }
  return $Metin
}

function Dagitimlari-Al {
  $metin = Clasp-Calistir @("list-deployments")
  if ($script:ClaspKod -ne 0 -or $metin -match "invalid_grant|invalid_rapt|not logged in|login") {
    return @{ Hata = $true; Metin = $metin; Liste = @() }
  }
  $liste = @()
  foreach ($satir in ($metin -split "`n")) {
    if ($satir -match "(AKfy[\w-]+)\s+@(HEAD|\d+)") {
      $liste += [pscustomobject]@{
        Id       = $Matches[1]
        Versiyon = $Matches[2]
        Satir    = $satir.Trim()
      }
    }
  }
  return @{ Hata = $false; Metin = $metin; Liste = $liste }
}

# --- 1) Giriş kontrolü --------------------------------------------------------
Write-Host "==> clasp girişi ve dağıtımlar kontrol ediliyor..." -ForegroundColor Cyan
$sonuc = Dagitimlari-Al
if ($sonuc.Hata) {
  Write-Host "Oturum yok ya da süresi dolmuş. clasp login başlatılıyor (tarayıcıda onaylayın)..." -ForegroundColor Yellow
  & clasp login
  if ($LASTEXITCODE -ne 0) { throw "clasp login başarısız." }
  $sonuc = Dagitimlari-Al
  if ($sonuc.Hata) { throw "Giriş sonrası da dağıtımlar alınamadı:`n$($sonuc.Metin)" }
}

# --- 2) Hedef dağıtımı seç ---------------------------------------------------
Write-Host "Mevcut dağıtımlar:" -ForegroundColor Cyan
$sonuc.Liste | ForEach-Object { Write-Host "  $($_.Satir)" }

$versiyonlular = @($sonuc.Liste | Where-Object { $_.Versiyon -ne "HEAD" })
if ($DeploymentId) {
  $hedef = $sonuc.Liste | Where-Object { $_.Id -eq $DeploymentId } | Select-Object -First 1
  if (-not $hedef) { throw "Verilen DeploymentId dağıtım listesinde yok: $DeploymentId" }
} else {
  if ($versiyonlular.Count -eq 0) {
    throw "Versiyonlu (yayındaki) dağıtım bulunamadı. Webhook URL'i değişmesin diye otomatik yeni dağıtım OLUŞTURULMADI."
  }
  $hedef = $versiyonlular | Sort-Object { [int]$_.Versiyon } -Descending | Select-Object -First 1
}
Write-Host "==> Güncellenecek dağıtım: $($hedef.Id) (@$($hedef.Versiyon))" -ForegroundColor Green

# --- 3) Push -------------------------------------------------------------------
Write-Host "==> clasp push..." -ForegroundColor Cyan
& clasp push -f
if ($LASTEXITCODE -ne 0) { throw "clasp push başarısız." }

# --- 4) Aynı dağıtıma yeni versiyon bas -----------------------------------------
$Aciklama = Aciklama-Hazirla $Aciklama
Write-Host "==> clasp deploy -i $($hedef.Id)..." -ForegroundColor Cyan
Write-Host "    Açıklama ($($Aciklama.Length) karakter): $Aciklama"
& clasp deploy -i $hedef.Id -d $Aciklama
if ($LASTEXITCODE -ne 0) { throw "clasp deploy başarısız." }

# --- 5) Doğrulama -------------------------------------------------------------------
Write-Host "==> Güncel dağıtımlar:" -ForegroundColor Cyan
$son = Dagitimlari-Al
$son.Liste | ForEach-Object { Write-Host "  $($_.Satir)" }
$guncel = $son.Liste | Where-Object { $_.Id -eq $hedef.Id } | Select-Object -First 1
if ($guncel -and $guncel.Versiyon -ne $hedef.Versiyon) {
  Write-Host "Tamam: $($hedef.Id) @$($hedef.Versiyon) -> @$($guncel.Versiyon)" -ForegroundColor Green
} else {
  Write-Host "Uyarı: versiyon numarası değişmedi görünüyor; Apps Script editöründe Manage deployments'tan kontrol edin." -ForegroundColor Yellow
}
Write-Host "Not: editörden kurulumKomutlar() yalnız komut listesi değiştiyse bir kez çalıştırılır."
