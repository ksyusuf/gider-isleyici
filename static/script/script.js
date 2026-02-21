// GÖRÜNTÜLEME ######################
$(function() {
    $('#goruntule').bind('click', function() {
        $('#bilgilendirme').html("Görüntüleniyor...")
        document.getElementById("toplam-tutar").style.visibility = "hidden";
        $.ajax( {
            url: '/goruntule',
            type: 'POST',
            success: function ( donen_veri ) {
                if(donen_veri === "Doküman boş."){
                    $('#bilgilendirme').html(donen_veri);
                    return 0;
                }
                // console.log(donen_veri);
                $("#harcama_tablosu tbody").empty()
                var top_harcama = 0;
                for (i = 0; i <= donen_veri.length - 1; i++) {
                    var row = $("<tr>");
                    row.append($("<td>").text(new Date(donen_veri[i].tarih).toLocaleDateString('tr-TR', {day: 'numeric', month: 'long'})));
                    row.append($("<td>").text(donen_veri[i].tutar + " ₺"));
                        top_harcama += parseFloat(donen_veri[i].tutar);
                    row.append($("<td>").text(donen_veri[i].firma));
                    row.append($("<td>").text(donen_veri[i].tür));
                    row.append($("<td>").text(donen_veri[i].malzeme));
                    row.append($("<td>").text(donen_veri[i].açıklama));
                    row.append("</tr>");
                    $("#harcama_tablosu tbody").append(row);
                };
                document.getElementById("toplam-tutar").style.display = "block";
                document.getElementById("toplam-tutar").style.visibility = "visible";
                document.getElementById("harcama_tablosu").style.display = "table"; // display: block yerine display: table kullanılıyor
                $('#bilgilendirme').html("Harcamalar geldi.");
                $('#toplam-tutar').html("Toplam: " + top_harcama.toFixed(2) + " ₺");
            },
            error: function( donen_veri )
            {
                $("#stil0").html("!! Görüntüleme Hatası !!");
            }
        });
    });
});

// KAYIT ######################
$(function() {
    $('#kayit').bind('click', function() {
        $('#bilgilendirme').html("Kaydediliyor...")
        $.ajax( {
            url: '/kayit',
            type: 'POST',
            success: function ( donen_veri ) {
                $("#harcama_tablosu tbody").empty()
                document.getElementById("harcama_tablosu").style.display = "none";
                document.getElementById("toplam-tutar").style.display = "none";
                $('#bilgilendirme').html(donen_veri);
            },
            error: function(request, ajaxOptions, thrownError)
            {
                $("#stil0").html("!! Kayıt Hatası !!");
            }
        });
    });
});