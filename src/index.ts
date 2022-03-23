import { config } from 'dotenv'; config();

import WebUntis, { Lesson, LoginSessionInformations, ShortData, Timegrid } from "webuntis";
import { WebhookClient, MessageEmbed } from 'discord.js';
import Logger, { LogLevel } from "log75";
import Enmap from 'enmap';

const logger = new Logger(LogLevel.Debug);
let { USERNAME, PASSWORD, SCHOOL, BASEURL, CLASS, GET_CLASSES, DB_DIR, WEBHOOK_ID, WEBHOOK_TOKEN, MESSAGE_CONTENT } = process.env;

for (const i of ['USERNAME', 'PASSWORD', 'SCHOOL', 'BASEURL', 'WEBHOOK_ID', 'WEBHOOK_TOKEN']) {
    if (!process.env[i]) {
        logger.error(`$${i} is not set`);
        process.exit(1);
    }
}

const TIMETABLE_DB: Enmap<string, Lesson> = new Enmap({ name: 'timetable', dataDir: DB_DIR });

const whClient = new WebhookClient({ id: WEBHOOK_ID!, token: WEBHOOK_TOKEN! });
const untis = new WebUntis(SCHOOL!, USERNAME!, PASSWORD!, BASEURL!);
let session: LoginSessionInformations|null = null;
let timegrid: Timegrid[]|null = null;

const tick = async () => {
    try {
        if (!session) {
            session = await untis.login();
            logger.info(`Logged in with session ${session.sessionId}:\n` +
                `Class ${session.klasseId} / User ${session.personId} (${session.personType})`);

            const classes = await untis.getClasses();

            if (GET_CLASSES == 'true') {
                logger.done(`Available classes:\n`
                    + `${classes.map(c => `${c.id} => ${c.longName} (${c.name}) ${c.active ? '' : '(Inactive)'}`).join('\n')}`);

                process.exit(0);
            }

            if (!CLASS) CLASS = ''+session.klasseId;
            const ownClass = classes.find(c => c.id == Number(CLASS));
            logger.info(`Selected class: ${ownClass?.name} (${ownClass?.id})`);
        }

        logger.info('Fetching timetable');
        const timetable = await untis.getTimetableForRange(
            new Date(Date.now() - (1000 * 60 * 60 * 24)), // 24 hours ago
            new Date(Date.now() + (1000 * 60 * 60 * 24 * 14)), // In 2 weeks
            Number(CLASS),
            WebUntis.TYPES.CLASS,
        );
        logger.done(`Fetched ${timetable.length} items`);

        timegrid = await untis.getTimegrid();
        logger.done('Fetched time grid');

        let newItems = 0;
        let embeds: MessageEmbed[] = [];
        for (const item of timetable) {
            if (!TIMETABLE_DB.has(String(item.id))) {
                TIMETABLE_DB.set(String(item.id), item);
                newItems++;
                continue;
            }

            // su -> Subject
            // ro -> Room
            // info -> Info text
            // substText -> Substitution text

            let changed = false;
            const embed = new MessageEmbed();
            const storedItem = TIMETABLE_DB.get(String(item.id))!;
            if (hasChanged(storedItem.su, item.su)) {
                changed = true;
                embed.addField('Old subjects', printShortData(storedItem.su), true);
                embed.addField('New subjects', printShortData(item.su), true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (hasChanged(storedItem.ro, item.ro)) {
                changed = true;
                embed.addField('Old rooms', printShortData(storedItem.ro), true);
                embed.addField('New rooms', printShortData(item.ro), true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (storedItem.info != item.info) {
                changed = true;
                embed.addField('Old info text', storedItem.info || '(None)', true);
                embed.addField('New info text', item.info || '(None)', true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (storedItem.substText != item.substText) {
                changed = true;
                embed.addField('Old substitution text', storedItem.substText || '(None)', true);
                embed.addField('New substitution text', item.substText || '(None)', true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (changed) {
                logger.info('Timetable update detected');

                const startDate = parseUntisTime(item.date, item.startTime);
                const endDate = parseUntisTime(item.date, item.endTime);

                const startStr = printTime(startDate, 'START');
                const endStr = printTime(endDate, 'END');
                let timeStr = startStr == endStr ? startStr : `${startStr} to ${endStr}`;

                embed
                    .setTitle('Timetable update')
                    .setColor('#ff6033')
                    .setDescription(
                        `<t:${Math.round(startDate.getTime()/1000)}:D>` +
                        `, ${timeStr}` +
                        ` (<t:${Math.round(startDate.getTime()/1000)}:R>)`
                    )
                    .setFooter({ text: `Lesson ID: ${item.id}` });

                    embeds.push(embed);
                    TIMETABLE_DB.set(String(item.id), item);
            }
        }

        if (embeds.length > 10) {
            for (let i = 0; i < embeds.length; i += 10) {
                await whClient.send({ embeds: embeds.slice(i, i+10), content: (MESSAGE_CONTENT && i == 0) ? MESSAGE_CONTENT : undefined });
            }
        } else if (embeds.length > 0) {
            await whClient.send({ content: MESSAGE_CONTENT || undefined, embeds });
        }

        if (newItems > 0) logger.info(`Discovered ${newItems} new timetable entries`);
    } catch(e) {
        console.error(e);

        // We assume that our session might have gotten revoked
        session = null;
        untis.logout().catch(e => console.error(e));
    }
}

setInterval(() => tick(), 60000);
tick();

const printShortData = (sub: ShortData[]) => sub
    .map(s => `${s.longname} (${s.name}) (ID: \`${s.id}\`)`)
    .join('\n');

const hasChanged = (a: ShortData[], b: ShortData[]) => {
    return printShortData(a) != printShortData(b);
}

const printTime = (time: Date, search: 'START'|'END'): string => {
    const discordTS = () => `<t:${Math.round(time.getTime()/1000)}:t>`;

    const weekday = time.getDay() + 1; // What dumbass decided to start the week at 2

    // i hate this
    let h = `${time.getHours()}`; if (h.length == 1) h = `0${h}`;
    let m = `${time.getMinutes()}`; if (m.length == 1) m = `0${m}`;
    const timeNum = Number(`${h}${m}`);

    const grid = timegrid?.find(t => t.day == weekday);
    if (!grid) return discordTS();

    const unit = grid.timeUnits.find(t => (search == 'END' ? t.endTime : t.startTime) == timeNum);
    if (!unit) return discordTS();

    return `lesson **${unit.name}**`;
}

const parseUntisTime = (dateNum: number, timeNum: number): Date => {
    const date = new Date();

    const [ year, month, day ] = [
        Number(String(dateNum).substring(0, 4)),
        Number(String(dateNum).substring(4, 6)),
        Number(String(dateNum).substring(6, 8)),
    ];

    const offset = String(timeNum).length == 3 ? 0 : 1;

    const [ startHour, startMin ] = [
        Number(String(timeNum).substring(0, 1+offset)),
        Number(String(timeNum).substring(1+offset, 3+offset)),
    ];

    date.setFullYear(year, month-1, day);
    date.setHours(startHour);
    date.setMinutes(startMin);

    return date;
}
