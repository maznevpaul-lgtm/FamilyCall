const emojis = [
    "😀","😂","🤣","😊","😍","🥰","😘","😜","🤪","😎","🤩","🥳","😏",
    "😒","😞","😔","😟","😕","🙁","😣","😖","😫","😩","🥺","😢","😭",
    "😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓",
    "🤗","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧",
    "😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷",
    "🤒","🤕","🤑","🤠","😈","👿","👹","👺","🤡","💩","👻","💀","☠️",
    "👽","👾","🤖","🎃","😺","😸","😹","😻","😼","😽","🙀","😿","😾",
    "👍","👎","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉",
    "👆","👇","☝️","🫵","✋","🤚","🖐","🖖","👋","🤙","💪","🦾","🖕",
    "✍️","🙏","🫲","🫱","🫱🏻‍🫲🏼","🤝","👏","🙌","👐","🤲","🤝","🙏"
];

document.addEventListener("DOMContentLoaded", () => {
    const emojiPicker = document.getElementById('emoji-picker');
    const emojiBtn = document.getElementById('emoji-btn');
    const msgInput = document.getElementById('msg-input');

    if (!emojiPicker || !emojiBtn || !msgInput) return;

    // Генерируем смайлики
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.className = 'emoji-item';
        span.innerText = emoji;
        span.onclick = () => {
            msgInput.value += emoji;
            // Вызываем событие input, чтобы поле расширилось автоматически
            msgInput.dispatchEvent(new Event('input'));
            msgInput.focus();
        };
        emojiPicker.appendChild(span);
    });

    // Открытие/закрытие пикера
    emojiBtn.onclick = (e) => {
        e.stopPropagation();
        if (emojiPicker.style.display === 'none' || emojiPicker.style.display === '') {
            emojiPicker.style.display = 'grid';
        } else {
            emojiPicker.style.display = 'none';
        }
    };

    // Закрытие пикера при клике мимо него
    document.addEventListener('click', (e) => {
        if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
            emojiPicker.style.display = 'none';
        }
    });
});